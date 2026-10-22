import {
  MIN_SEARCH_TERM_LENGTH,
  newId,
  searchTerms,
  type SearchDocument,
  type SearchHit,
  type SearchObjectScope,
  type SearchProvider,
  type SearchRecordRef,
  type SearchRequest,
  type SearchableObjectType,
  type Uuid,
} from '@crm/core';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { constraintToSql } from '../record-scope.js';
import { searchDocuments } from '../schema/search.js';

/**
 * Global search on Postgres: full-text, with pg_trgm behind it (ADR-0028).
 *
 * It implements `SearchProvider` from `@crm/core` and is the only code in the
 * product that knows search is Postgres-shaped. Nothing above it sees a
 * tsquery, an index name or a table.
 *
 * The context it needs is the caller's **tenant-scoped transaction**. That is
 * not an implementation detail that leaked: it is where
 * `SET LOCAL app.tenant_id` lives, so running here means RLS applies to every
 * statement below exactly as it does to a record query (CLAUDE.md §5.1). The
 * explicit `tenant_id = …` predicates are belt and braces on top of it.
 *
 * Four rules are applied **while rows are selected**, never afterwards:
 *
 *   1. the tenant, by RLS and by predicate;
 *   2. the actor's record scope, per object type, against the `owner_id`
 *      copied onto each document;
 *   3. field-level permissions, as `field_key in (…)` per object type — which
 *      is what makes a hidden field unsearchable *and* keeps it out of the
 *      snippet, since the snippet is the matched row's own value;
 *   4. soft deletes, by the index simply not holding deleted records.
 *
 * Filtering after the fact would be a leak waiting for the next refactor, and
 * would also quietly break the result count.
 */
export class PostgresSearchProvider implements SearchProvider<Tx> {
  async search(tx: Tx, request: SearchRequest): Promise<readonly SearchHit[]> {
    const terms = usableTerms(request.term);
    const scopes = request.scopes.filter((scope) => scope.fieldKeys.length > 0);
    if (terms.length === 0 || scopes.length === 0) return [];

    const visible = visibilityPredicate(scopes);
    const matched = await this.fullText(tx, request, terms, visible);

    if (matched.length >= request.limit) return matched.slice(0, request.limit);

    // Only now is the trigram index consulted, so the common case costs one
    // index scan. See ADR-0028 §4: a fuzzy pass on every keystroke is a
    // second GIN scan over a wider candidate set, for a result that matters
    // on perhaps one query in twenty.
    const fuzzy = await this.fuzzy(tx, request, terms, visible, request.limit - matched.length);

    const seen = new Set(matched.map((hit) => keyOf(hit)));
    return [...matched, ...fuzzy.filter((hit) => !seen.has(keyOf(hit)))].slice(0, request.limit);
  }

  /**
   * Write these records' documents, replacing whatever was there.
   *
   * Delete-then-insert rather than a per-field upsert: a field that was
   * cleared has no row to update, and leaving its old row behind would keep
   * the record findable by a value it no longer holds. Both statements are in
   * the caller's transaction, so a reader never sees the gap.
   *
   * Idempotent, as at-least-once delivery requires (ADR-0006): running it
   * twice leaves exactly the same rows.
   */
  async index(tx: Tx, tenantId: Uuid, documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;

    await this.remove(
      tx,
      tenantId,
      documents.map((document) => ({
        objectType: document.objectType,
        recordId: document.recordId,
      })),
    );

    const rows = documents.flatMap((document) =>
      document.fields.map((field) => ({
        id: newId(),
        tenantId,
        objectType: document.objectType,
        recordId: document.recordId,
        fieldKey: field.fieldKey,
        ownerId: document.ownerId,
        value: field.value,
        weight: field.weight,
        recordUpdatedAt: document.updatedAt,
      })),
    );

    if (rows.length > 0) await tx.insert(searchDocuments).values(rows);
  }

  async remove(tx: Tx, tenantId: Uuid, refs: readonly SearchRecordRef[]): Promise<void> {
    if (refs.length === 0) return;

    // Grouped so a batch of twenty costs one statement per object type rather
    // than twenty, and so each statement hits the unique index by its prefix.
    const byType = new Map<SearchableObjectType, string[]>();
    for (const ref of refs) {
      const ids = byType.get(ref.objectType) ?? [];
      ids.push(ref.recordId);
      byType.set(ref.objectType, ids);
    }

    for (const [objectType, ids] of byType) {
      await tx
        .delete(searchDocuments)
        .where(
          and(
            eq(searchDocuments.tenantId, tenantId),
            eq(searchDocuments.objectType, objectType),
            inArray(searchDocuments.recordId, ids),
          ),
        );
    }
  }

  /** Drop this tenant's whole index. A rebuild starts here (`reindexTenant`). */
  async clear(tx: Tx, tenantId: Uuid): Promise<void> {
    await tx.delete(searchDocuments).where(eq(searchDocuments.tenantId, tenantId));
  }

  private async fullText(
    tx: Tx,
    request: SearchRequest,
    terms: readonly string[],
    visible: SQL,
  ): Promise<SearchHit[]> {
    const result = await tx.execute(
      fullTextStatement(request.tenantId, terms, visible, request.limit),
    );
    return toHits(result.rows);
  }

  private async fuzzy(
    tx: Tx,
    request: SearchRequest,
    terms: readonly string[],
    visible: SQL,
    limit: number,
  ): Promise<SearchHit[]> {
    const result = await tx.execute(
      fuzzyStatement(request.tenantId, longestTerm(terms), visible, limit),
    );
    return toHits(result.rows);
  }
}

/**
 * How many matching index rows are ranked, at most (ADR-0028 §4, ADR-0041 §4).
 *
 * The cost of a search used to be proportional to **how many rows match**, not to how big the
 * tenant is: every match had to be fetched from the heap and ranked before the best ten could be
 * known. A surname shared by one record in sixty matches sixty-seven thousand rows at a million
 * contacts, and measured that took 3 to 6 seconds, which is not a slow search but one that ties up
 * a database connection long enough to starve everything else.
 *
 * So the matches are taken in order of `record_updated_at`, newest first, from an index in that
 * order (`search_documents_recent_idx`), and only the first `SEARCH_CANDIDATE_CAP` are ranked.
 * What that changes, and what it does not:
 *
 *   - A term that matches fewer rows than this (any selective term, which is nearly every query a
 *     person types after a second keystroke) is **unchanged**: the planner still reads the
 *     full-text index for it, and every match is ranked.
 *   - A term that matches more is ranked among its most recently updated matches. For a broad term
 *     nearly all matches rank alike, so "the best ten" was "the ten most recent of the best
 *     weight" anyway; what is given up is an older, higher-weighted match beating a newer,
 *     lower-weighted one. Typing a little more narrows it, and a palette is for exactly that.
 *   - The cap applies **after** the visibility predicate (it is part of the same WHERE), so it
 *     counts only rows the caller may see: a cap cannot be filled, or learned about, through rows
 *     they may not.
 *
 * Six hundred is a few pages of a palette's worth of candidates: well above the ten that are shown
 * and the handful of fields each record can match in, well below the thousands that cost seconds.
 */
export const SEARCH_CANDIDATE_CAP = 600;

/**
 * The full-text statement, exported so a performance test can `EXPLAIN` the
 * exact query the provider runs rather than a hand-written lookalike.
 *
 * Shape, and why:
 *
 *   - the tsquery is `a:* | b:*`, **or** rather than and. One index row holds
 *     one field, so "John Smith" has `john` in `first_name` and `smith` in
 *     `last_name` and no single row contains both; requiring both would find
 *     nobody. Summing the per-row ranks puts the record that matched two words
 *     above the one that matched one, which is the behaviour `and` was for.
 *   - `:*` makes every term a prefix, so results appear while somebody is
 *     still typing.
 *   - the terms are a single bound parameter built from `searchTerms`, which
 *     has already reduced the input to bare words — no `&`, `|`, `!`, `:` or
 *     quote can reach `to_tsquery` (CLAUDE.md §5.7).
 *   - the ranked field and value come from `array_agg … order by rank` rather
 *     than a second query, so the snippet is always the best-matching row the
 *     caller was allowed to match on in the first place.
 */
export function fullTextStatement(
  tenantId: string,
  terms: readonly string[],
  visible: SQL,
  limit: number,
): SQL {
  const query = terms.map((term) => `${term}:*`).join(' | ');

  return sql`
    with hits as (
      select object_type,
             record_id,
             field_key,
             value,
             record_updated_at,
             ts_rank(search_vector, to_tsquery('simple', ${query})) as rank
      from search_documents
      where tenant_id = ${tenantId}::uuid
        and search_vector @@ to_tsquery('simple', ${query})
        and (${visible})
      order by record_updated_at desc, id desc
      limit ${SEARCH_CANDIDATE_CAP}
    )
    select object_type,
           record_id,
           sum(rank)::float8 as score,
           (array_agg(field_key order by rank desc, field_key))[1] as matched_field_key,
           (array_agg(value order by rank desc, field_key))[1] as matched_value
    from hits
    group by object_type, record_id
    order by score desc, max(record_updated_at) desc, record_id desc
    limit ${limit}
  `;
}

/**
 * The trigram statement (ADR-0028 §4).
 *
 * `<%` is pg_trgm's word-similarity operator: "is this term close to some word
 * inside that value". It is what catches `akme` for Acme and `9876` in the
 * middle of a number — things full-text, which matches whole tokens and
 * prefixes, cannot reach. It is index-backed by `search_documents_trgm_idx`.
 *
 * One term, the longest the caller typed. `word_similarity` compares a phrase
 * against word extents and gets noticeably worse as the left side grows, and
 * this is a fallback for a short query that found little, not a second ranker.
 */
export function fuzzyStatement(tenantId: string, term: string, visible: SQL, limit: number): SQL {
  return sql`
    with hits as (
      select object_type,
             record_id,
             field_key,
             value,
             record_updated_at,
             word_similarity(${term}, value) as similarity
      from search_documents
      where tenant_id = ${tenantId}::uuid
        and ${term} <% value
        and (${visible})
      order by record_updated_at desc, id desc
      limit ${SEARCH_CANDIDATE_CAP}
    )
    select object_type,
           record_id,
           max(similarity)::float8 as score,
           (array_agg(field_key order by similarity desc, field_key))[1] as matched_field_key,
           (array_agg(value order by similarity desc, field_key))[1] as matched_value
    from hits
    group by object_type, record_id
    order by score desc, max(record_updated_at) desc, record_id desc
    limit ${limit}
  `;
}

/**
 * "Which rows may this actor match on", as one predicate.
 *
 * One block per object type the actor may read, each carrying that object's
 * own record scope and its own list of readable searchable fields — because
 * the two differ per object: a rep may hold `all` on accounts and `own` on
 * deals, and may be allowed `email` on a contact but not on a lead.
 *
 * An object type the actor cannot read has no block, so it is not excluded
 * later — it is never selected. An object type whose searchable fields are all
 * hidden is dropped by the caller before it gets here, for the same reason.
 */
export function visibilityPredicate(scopes: readonly SearchObjectScope[]): SQL {
  const blocks = scopes.map((scope) => {
    const parts: SQL[] = [
      sql`${searchDocuments.objectType} = ${scope.objectType}`,
      sql`${searchDocuments.fieldKey} in (${sql.join(
        scope.fieldKeys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    ];

    const ownership = constraintToSql(scope.constraint, sql`${searchDocuments.ownerId}`);
    if (ownership !== undefined) parts.push(ownership);

    return sql`(${and(...parts)})`;
  });

  // `false` cannot happen — the caller drops an empty scope list — but a
  // predicate that defaults to "everything" if this were ever reached is not
  // a mistake worth leaving available.
  if (blocks.length === 0) return sql`false`;
  const any = or(...blocks)!;

  // When every block is the same person's own records (a rep, on every object they may search),
  // say so once, outside the OR as well as inside it. The result is identical, but only a condition
  // at the top level can become an index condition: `search_documents_fts_idx` and
  // `search_documents_trgm_idx` lead with `(tenant_id, owner_id)`, so a rep's search reads the
  // rep's rows, a fortieth of the tenant, instead of fetching every match and discarding most of
  // them (migration 0021, ADR-0041).
  const owners = new Set<string>();
  for (const scope of scopes) {
    if (scope.constraint.kind === 'own') owners.add(scope.constraint.userId);
    else return any;
  }
  const [only] = [...owners];
  if (owners.size !== 1 || only === undefined) return any;
  return sql`(${searchDocuments.ownerId} = ${only}::uuid and ${any})`;
}

/** Terms long enough to be worth an index probe. */
function usableTerms(input: string): string[] {
  return searchTerms(input).filter((term) => term.length >= MIN_SEARCH_TERM_LENGTH);
}

function longestTerm(terms: readonly string[]): string {
  return terms.reduce((longest, term) => (term.length > longest.length ? term : longest));
}

function keyOf(hit: SearchHit): string {
  return `${hit.objectType}:${hit.recordId}`;
}

interface HitRow {
  readonly object_type: string;
  readonly record_id: string;
  readonly score: number;
  readonly matched_field_key: string;
  readonly matched_value: string;
}

function toHits(rows: unknown[]): SearchHit[] {
  return (rows as HitRow[]).map((row) => ({
    objectType: row.object_type as SearchableObjectType,
    recordId: row.record_id as Uuid,
    score: Number(row.score),
    matchedFieldKey: row.matched_field_key,
    matchedValue: row.matched_value,
  }));
}
