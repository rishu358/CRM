import type { Uuid } from '../ids/index.js';
import type { RecordConstraint } from '../permissions/types.js';

/**
 * Global search, as an interface (ADR-0009, ADR-0028, MVP_SPEC §M7).
 *
 * Everything in this file is vendor-neutral on purpose. CLAUDE.md §2 says the
 * Postgres implementation sits behind a `SearchProvider` so Meilisearch can
 * replace it later, and that promise is only real if no caller can tell which
 * engine is underneath. So: no SQL, no tsquery, no index names, and no type
 * from `@crm/db` appears here.
 *
 * The one thing that is *not* negotiable, whoever implements it, is that the
 * four scoping rules below are applied by the engine when it selects
 * documents — never by filtering what it returned:
 *
 *   1. the tenant (`SearchRequest.tenantId`)
 *   2. the actor's record scope, per object type (`SearchObjectScope.constraint`)
 *   3. field-level permissions (`SearchObjectScope.fieldKeys`)
 *   4. soft deletes (a deleted record has no documents in the index)
 *
 * Search reads across every object at once, so it is the easiest read path in
 * the product to leak from. Filtering afterwards would also quietly break the
 * result count: ask for twenty, throw half away, show nine.
 */

export const SEARCHABLE_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal', 'activity'] as const;

export type SearchableObjectType = (typeof SEARCHABLE_OBJECT_TYPES)[number];

const SEARCHABLE_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(SEARCHABLE_OBJECT_TYPES);

export function isSearchableObjectType(value: unknown): value is SearchableObjectType {
  return typeof value === 'string' && SEARCHABLE_OBJECT_TYPE_SET.has(value);
}

/**
 * How much a field contributes to a result's rank.
 *
 * Four buckets because Postgres `tsvector` has four, and naming them A–D keeps
 * the mapping obvious; an engine without weights can treat them as 4, 3, 2, 1.
 * This is a *ranking* input and nothing else — it never decides whether a
 * caller may see a field.
 */
export const SEARCH_WEIGHTS = ['A', 'B', 'C', 'D'] as const;
export type SearchWeight = (typeof SEARCH_WEIGHTS)[number];

export interface SearchableField {
  /**
   * The `field_definitions` key, which is also the column name. It is the same
   * string `canReadField` is asked about, so a field permission written by an
   * administrator applies to search without anyone mapping names (ADR-0004).
   */
  readonly key: string;
  readonly weight: SearchWeight;
}

/**
 * What global search looks at, per object type (MVP_SPEC §M7: "name, email,
 * phone, company").
 *
 * This is the single list. The indexer uses it to decide what to write, and
 * the API uses it to decide what a caller may match on — if the two ever came
 * from different lists, the difference would be either a dead search or a
 * field that is searchable while hidden.
 *
 * Deliberately **not** every column. Three absences are decisions:
 *
 *   - `activities.body` is out. It is sanitized markup (ADR-0024); matching
 *     inside tags is both wrong and slow, and a note's body is the most likely
 *     place in the product for something a colleague should not stumble over.
 *   - `deals.amount_minor`, `accounts.gstin` and the other identifiers are out.
 *     Nobody opens a command palette and types a GSTIN, and each one indexed
 *     is one more value reachable a character at a time.
 *   - custom fields are out, for now. They are per tenant, so indexing them
 *     means the index schema stops being fixed; ADR-0028 §6 says what that
 *     would take.
 */
export const SEARCHABLE_FIELDS: Readonly<Record<SearchableObjectType, readonly SearchableField[]>> =
  {
    account: [
      { key: 'name', weight: 'A' },
      { key: 'domain', weight: 'B' },
      { key: 'email', weight: 'B' },
      { key: 'phone', weight: 'C' },
    ],
    contact: [
      { key: 'first_name', weight: 'A' },
      { key: 'last_name', weight: 'A' },
      { key: 'email', weight: 'B' },
      { key: 'phone', weight: 'C' },
    ],
    lead: [
      { key: 'first_name', weight: 'A' },
      { key: 'last_name', weight: 'A' },
      { key: 'company', weight: 'B' },
      { key: 'email', weight: 'B' },
      { key: 'phone', weight: 'C' },
    ],
    deal: [{ key: 'name', weight: 'A' }],
    activity: [{ key: 'subject', weight: 'A' }],
  };

/** The keys global search may match on for an object type. */
export function searchableFieldKeys(objectType: SearchableObjectType): readonly string[] {
  return SEARCHABLE_FIELDS[objectType].map((field) => field.key);
}

/**
 * Shorter than this and the term is not worth running.
 *
 * A single character matches a large fraction of a tenant's rows, which costs
 * the whole latency budget to produce a result nobody wanted. The palette
 * simply waits for the second keystroke.
 */
export const MIN_SEARCH_TERM_LENGTH = 2;

/** How many results a palette shows without scrolling. */
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

/**
 * How many words of a query are used.
 *
 * Each one is a separate index probe, so an unbounded list is an unbounded
 * amount of work for one request. Five is more than anybody types into a
 * command palette.
 */
export const MAX_SEARCH_TERMS = 5;

/**
 * Split what somebody typed into the words an engine can match on.
 *
 * Pure, and tested on its own, because it is the only place a user's string is
 * taken apart. Everything that is not a letter, a digit or a combining mark
 * becomes a separator: that folds `john.smith@acme.com` into
 * `john smith acme com` and `+91-98765-43210` into `91 98765 43210`, so a
 * person typing part of an address or a number still finds the record. It also
 * means no operator — `&`, `|`, `!`, `:`, `*`, a quote — can survive into
 * whatever query language the provider builds, which is the second reason it is
 * done here rather than in SQL (CLAUDE.md §5.7).
 *
 * `\p{M}` is in that list and is not decoration. In Devanagari the vowel signs
 * and the virama of `शर्मा` are **marks**, not letters, so a class of
 * `\p{L}\p{N}` alone shreds the name into `शर` and `म` and the person becomes
 * unfindable by their own name. Our first market writes in these scripts
 * (MVP_SPEC §1), so this is a correctness bug in the default case, not an
 * internationalisation nicety. A mark is not an operator in any query language
 * here, so keeping them costs nothing on the safety side.
 */
export function searchTerms(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS);
}

/** Whether a raw query string is worth sending to the provider at all. */
export function isUsableSearchTerm(input: string): boolean {
  const terms = searchTerms(input);
  return terms.some((term) => term.length >= MIN_SEARCH_TERM_LENGTH);
}

// ---------------------------------------------------------------------------
// Documents: what the indexer writes
// ---------------------------------------------------------------------------

/** One field of one record, as it is indexed. */
export interface SearchDocumentField {
  readonly fieldKey: string;
  readonly value: string;
  readonly weight: SearchWeight;
}

/**
 * One record, as it is indexed.
 *
 * `ownerId` is carried so record scope can be applied by the engine without
 * joining back to the record's own table — the join would be the thing that
 * made search slow, and an engine on another machine could not do it at all.
 * It is a copy, so it is only as fresh as the last event the indexer saw;
 * ADR-0028 §5 says what the API does about that.
 */
export interface SearchDocument {
  readonly objectType: SearchableObjectType;
  readonly recordId: Uuid;
  readonly ownerId: Uuid | null;
  /** The record's `updated_at`, used to break ties between equal scores. */
  readonly updatedAt: Date;
  readonly fields: readonly SearchDocumentField[];
}

/** A record the index should no longer hold. */
export interface SearchRecordRef {
  readonly objectType: SearchableObjectType;
  readonly recordId: Uuid;
}

// ---------------------------------------------------------------------------
// Queries: what the API asks for
// ---------------------------------------------------------------------------

/**
 * The actor's reach over one object type.
 *
 * Built from `can()` and `canReadField()` by the caller and handed to the
 * engine whole. An object type the actor may not read simply has no scope in
 * the request, so there is nothing for the engine to exclude later.
 */
export interface SearchObjectScope {
  readonly objectType: SearchableObjectType;
  /** `all`, `team` or `own`, from `can(actor, 'read', …)`. */
  readonly constraint: RecordConstraint;
  /**
   * The subset of `searchableFieldKeys(objectType)` this actor may read.
   *
   * Empty means the actor may read the object but none of its searchable
   * fields, which is "match nothing" — not "match everything".
   */
  readonly fieldKeys: readonly string[];
}

export interface SearchRequest {
  readonly tenantId: Uuid;
  /** Raw, as typed. The provider tokenizes it with `searchTerms`. */
  readonly term: string;
  readonly limit: number;
  readonly scopes: readonly SearchObjectScope[];
}

export interface SearchHit {
  readonly objectType: SearchableObjectType;
  readonly recordId: Uuid;
  /**
   * Diagnostic only. The **array order** is the ranking: a provider may blend
   * several passes whose scores are not on one scale — the Postgres one puts
   * full-text matches ahead of trigram ones — so re-sorting by this number
   * would undo the ordering the provider just produced.
   */
  readonly score: number;
  /** Which field matched. Always one of the scope's `fieldKeys`. */
  readonly matchedFieldKey: string;
  /** That field's indexed value — the only text a result may quote. */
  readonly matchedValue: string;
}

/**
 * Which records of one object type match a typed query, for a list or an export to narrow itself to
 * (ADR-0041 §5).
 *
 * The palette wants the best few hits across everything; a list's search box wants **the records of
 * this one object that match**, so the list can then apply its own sort, filters, scope and paging to
 * them. Asking the engine for ids and letting the list do the rest is what keeps the list working
 * whichever engine is underneath: a join between a list's table and an index only exists while the
 * index is in the same database.
 *
 * The meaning, which every implementation must give (the conformance suite in
 * `./provider-contract.ts` checks it):
 *
 *   - **Every word must match.** A record matches when each word of the query is the start of a word
 *     in one of the fields the caller may read, and different words may match in different fields:
 *     "john smith" finds the record with `john` in `first_name` and `smith` in `last_name`.
 *   - **A word is a prefix**, so results appear as somebody types. A word does not *exactly* match in
 *     the middle of another word: `ndeep` does not find `Sandeep` when anything else matches. (This
 *     replaced a substring match, which could not be indexed under row-level security. When nothing
 *     matches, typo tolerance may still bring such a record in: the Postgres provider's fuzzy pass
 *     does, because `ndeep` is within a typo of `sandeep`.)
 *   - **The four scoping rules apply while selecting**, exactly as for `search`: tenant, record scope,
 *     field permissions, soft deletes.
 *   - **Newest first**: by the record's `updatedAt`, then id. Not by relevance: for a filter, "which
 *     records" matters and "which best" does not.
 *   - **At most `limit` records**, and `truncated` says whether there were more. A caller must be
 *     able to tell "these are all of them" from "these are the first of many".
 *   - An engine may also tolerate typos; the Postgres one does so only when nothing matches exactly.
 *     What it must never do is return a record the four scoping rules exclude.
 */
export interface RecordMatchRequest {
  readonly tenantId: Uuid;
  /** Raw, as typed. The provider tokenizes it with `searchTerms`. */
  readonly term: string;
  /** The caller's reach over the one object type being listed. */
  readonly scope: SearchObjectScope;
  /** The most records to return. */
  readonly limit: number;
}

export interface RecordMatches {
  readonly recordIds: readonly Uuid[];
  /** There were more matching records than `limit`; these are the most recently updated ones. */
  readonly truncated: boolean;
}

/** How many matching records a list's search box narrows to. A page is 50; this is a few pages' worth. */
export const LIST_MATCH_LIMIT = 300;

/**
 * How many an export of a searched view may hold. It runs in a background job and has no page to fill,
 * so it may cost more; past this it is refused, not silently cut (see the export handler).
 */
export const EXPORT_MATCH_LIMIT = 5000;

/**
 * The seam (ADR-0009, ADR-0028).
 *
 * `Ctx` is whatever handle the implementation needs to do its work. The
 * Postgres one needs the caller's **tenant-scoped transaction**, because that
 * is where `SET LOCAL app.tenant_id` lives and therefore where RLS applies
 * (CLAUDE.md §5.1); an engine in another process would ignore it and must then
 * enforce `SearchRequest.tenantId` itself, which ADR-0028 §6 spells out as the
 * price of moving. Typing it rather than hiding it behind `unknown` means a
 * replacement cannot quietly drop the thing that makes isolation work.
 */
export interface SearchProvider<Ctx = unknown> {
  /** Results, best first, already filtered by tenant, scope and field access. */
  search(ctx: Ctx, request: SearchRequest): Promise<readonly SearchHit[]>;

  /**
   * The records of one object type that match, for a list or export to narrow itself to.
   * See `RecordMatchRequest` for the meaning every implementation must give it.
   */
  matchRecordIds(ctx: Ctx, request: RecordMatchRequest): Promise<RecordMatches>;

  /**
   * Write or replace these records' documents.
   *
   * Must be idempotent: outbox delivery is at-least-once (ADR-0006), so this
   * is called twice for the same record as a matter of course, not as an
   * exception.
   */
  index(ctx: Ctx, tenantId: Uuid, documents: readonly SearchDocument[]): Promise<void>;

  /**
   * Forget these records.
   *
   * Called for a soft delete as well as a hard one: a record in the Recycle
   * Bin must not be findable, and is re-indexed if it is restored.
   */
  remove(ctx: Ctx, tenantId: Uuid, refs: readonly SearchRecordRef[]): Promise<void>;

  /**
   * Forget everything this tenant has indexed.
   *
   * A rebuild starts here, so that records deleted while the index was being
   * written by something other than the relay — a seed, a restore, a bulk
   * import — do not survive as entries nothing will ever clear. It is also
   * what a tenant erasure needs (MVP_SPEC M11), since the index holds copies
   * of names, addresses and numbers.
   */
  clear(ctx: Ctx, tenantId: Uuid): Promise<void>;
}
