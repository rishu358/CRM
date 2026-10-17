import { Injectable } from '@nestjs/common';
import type { FieldDefinition, RecordConstraint } from '@crm/core';
import type { ParsedFilter, SortDirection } from '@crm/contracts';
import {
  accounts,
  type Account,
  type Tx,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  or,
  sql,
  type SQL,
} from '@crm/db';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { keysetPredicate } from '../../common/keyset.js';
import {
  constraintToSql,
  expressionForField,
  filterToSql,
  notDeleted,
  searchToSql,
} from './accounts.sql-helpers.js';

/**
 * Data access for accounts.
 *
 * Only the accounts service calls this. No other module may: a module reaching
 * into another's repository is the boundary violation that makes the monolith
 * impossible to split later (ADR-0001). Contacts and, later, deals link to an
 * account through `AccountsService`, never through this file or the table.
 *
 * Every query runs inside the caller's tenant-scoped transaction, so RLS adds
 * the tenant predicate. The explicit `tenant_id` comparisons here are belt and
 * braces, not the actual isolation.
 */
export interface ListOptions {
  readonly constraint: RecordConstraint;
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly sort?: { field: string; direction: SortDirection } | undefined;
  readonly filters: readonly ParsedFilter[];
  readonly search?: string | undefined;
  readonly fields: readonly FieldDefinition[];
}

export interface ListResult {
  readonly rows: (Account & { cursorValue: string | null })[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

@Injectable()
export class AccountsRepository {
  async list(tx: Tx, tenantId: string, options: ListOptions): Promise<ListResult> {
    const sortField = options.sort?.field ?? 'created_at';
    const direction = options.sort?.direction ?? 'asc';
    const sortExpression = expressionForField(sortField, options.fields);

    const predicates: SQL[] = [eq(accounts.tenantId, tenantId), notDeleted()];

    const scope = constraintToSql(options.constraint);
    if (scope !== undefined) predicates.push(scope);

    for (const filter of options.filters) {
      predicates.push(filterToSql(filter, options.fields));
    }

    if (options.search !== undefined && options.search.length > 0) {
      predicates.push(searchToSql(options.search));
    }

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null) {
      predicates.push(keysetPredicate(sortExpression, sql`${accounts.id}`, direction, cursor));
    }

    // One row more than asked for, so "is there another page" needs no count.
    //
    // The sort value is rendered to text **by Postgres** and carried in the
    // cursor verbatim. Deriving it from the returned JavaScript value loses
    // precision — a timestamptz has microseconds and a JS Date has only
    // milliseconds, and a revenue past 2^53 is not representable at all — so
    // the next page's "strictly after" comparison would include the boundary
    // row again and the caller would see duplicates.
    const rows = await tx
      .select({
        ...getTableColumns(accounts),
        cursorValue: sql<string | null>`(${sortExpression})::text`,
      })
      .from(accounts)
      .where(and(...predicates))
      .orderBy(
        direction === 'asc' ? asc(sortExpression) : desc(sortExpression),
        direction === 'asc' ? asc(accounts.id) : desc(accounts.id),
      )
      .limit(options.limit + 1);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    return {
      rows: page,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ value: last.cursorValue, id: last.id })
          : null,
    };
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<Account | null> {
    const rows = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id), notDeleted()))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Does this id name a live account in this tenant?
   *
   * Used to validate `parent_account_id`. Returns a boolean rather than the
   * row: the caller is only allowed to learn that the reference is usable, and
   * handing back a record the actor's own scope might exclude would be a
   * read through the back door.
   */
  async existsLive(tx: Tx, tenantId: string, id: string): Promise<boolean> {
    const rows = await tx
      .select({ one: sql<number>`1` })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id), notDeleted()))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The ids on the path from `startId` up to the root, nearest first.
   *
   * The service uses this to refuse a parent that is already a descendant,
   * before the database's trigger has to (ADR-0018) — the trigger is the
   * guarantee, this is the part that produces a sentence a user can act on.
   *
   * Bounded by `maxDepth` so that data written before the trigger existed
   * cannot make this spin.
   *
   * Tenant-scoped but **not** record-scoped: an account's parent may well be
   * owned by somebody the actor cannot see, and a hierarchy check that only
   * looked at the actor's own records would miss exactly the cycles a rep is
   * most likely to create. Only ids leave this method, and they go nowhere
   * except the comparison below.
   */
  async ancestorIds(tx: Tx, tenantId: string, startId: string, maxDepth = 1000): Promise<string[]> {
    const result = await tx.execute(sql`
      with recursive ancestors as (
        select a.id, a.parent_account_id, 1 as depth
          from accounts a
         where a.tenant_id = ${tenantId}::uuid and a.id = ${startId}::uuid
        union all
        select a.id, a.parent_account_id, ancestors.depth + 1
          from accounts a
          join ancestors on a.id = ancestors.parent_account_id
         where a.tenant_id = ${tenantId}::uuid and ancestors.depth < ${maxDepth}
      )
      select id from ancestors
    `);
    return (result.rows as unknown as { id: string }[]).map((row) => row.id);
  }

  async insert(tx: Tx, values: typeof accounts.$inferInsert): Promise<Account> {
    const rows = await tx.insert(accounts).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Update guarded by the version the caller read.
   *
   * The version is part of the WHERE clause, so a concurrent edit makes this
   * match zero rows rather than overwriting. Returning null lets the service
   * raise 409 instead of silently clobbering a colleague's work.
   */
  async updateWithVersion(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof accounts.$inferInsert>,
  ): Promise<Account | null> {
    const rows = await tx
      .update(accounts)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(accounts.tenantId, tenantId),
          eq(accounts.id, id),
          eq(accounts.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Soft delete, so the record can be restored from the Recycle Bin.
   *
   * Children keep pointing at the deleted parent on purpose (ADR-0018):
   * nulling the link would make the delete unreversible in the one way that
   * matters, because a restore cannot put back what it was never told.
   */
  async softDelete(
    tx: Tx,
    tenantId: string,
    id: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<Account | null> {
    const rows = await tx
      .update(accounts)
      .set({ deletedAt: new Date(), updatedBy: actorId, version: expectedVersion + 1 })
      .where(
        and(
          eq(accounts.tenantId, tenantId),
          eq(accounts.id, id),
          eq(accounts.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Live accounts in this tenant with the same domain, for duplicate detection. */
  async findByDomain(tx: Tx, tenantId: string, domain: string): Promise<Account[]> {
    return tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.domain, domain), notDeleted()))
      .limit(5);
  }

  /**
   * Live accounts that look like the same company (ADR-0023): an exact domain,
   * or a name close enough under pg_trgm.
   *
   * `%` is the index-assisted prefilter (it uses the GIN trigram index from
   * 0002 at the default 0.3 threshold) and the explicit `similarity()` is the
   * real cut, so the threshold lives in one named constant instead of a
   * session setting. `constraint` is the reader's record scope, applied in SQL.
   */
  async findDuplicates(
    tx: Tx,
    tenantId: string,
    criteria: { readonly domain?: string | undefined; readonly name?: string | undefined },
    constraint: RecordConstraint,
    minimumSimilarity: number,
    limit: number,
  ): Promise<(Account & { nameScore: number | null })[]> {
    const matches: SQL[] = [];
    if (criteria.domain !== undefined) {
      matches.push(sql`lower(${accounts.domain}) = ${criteria.domain.toLowerCase()}`);
    }
    const score =
      criteria.name === undefined
        ? sql<number | null>`null::float4`
        : sql<number | null>`similarity(${accounts.name}, ${criteria.name})`;
    if (criteria.name !== undefined) {
      matches.push(
        sql`(${accounts.name} % ${criteria.name} and similarity(${accounts.name}, ${criteria.name}) >= ${minimumSimilarity})`,
      );
    }
    if (matches.length === 0) return [];

    const predicates: SQL[] = [eq(accounts.tenantId, tenantId), notDeleted(), or(...matches)!];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    return tx
      .select({ ...getTableColumns(accounts), nameScore: score })
      .from(accounts)
      .where(and(...predicates))
      .orderBy(desc(score), asc(accounts.createdAt), asc(accounts.id))
      .limit(limit);
  }

  /** A live account in this tenant, within the reader's scope, or null. */
  async findReadable(
    tx: Tx,
    tenantId: string,
    id: string,
    constraint: RecordConstraint,
  ): Promise<Account | null> {
    const predicates: SQL[] = [eq(accounts.tenantId, tenantId), eq(accounts.id, id), notDeleted()];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);
    const rows = await tx
      .select()
      .from(accounts)
      .where(and(...predicates))
      .limit(1);
    return rows[0] ?? null;
  }
}
