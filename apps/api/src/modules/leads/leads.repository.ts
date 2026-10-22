import { Injectable } from '@nestjs/common';
import type { FieldDefinition, RecordConstraint } from '@crm/core';
import type { ParsedFilter, SortDirection } from '@crm/contracts';
import {
  leads,
  type Lead,
  type Tx,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  not,
  or,
  sql,
  type SQL,
} from '@crm/db';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { keysetPredicate } from '../../common/keyset.js';
import {
  constraintToSql,
  emailIs,
  expressionForField,
  filterToSql,
  notDeleted,
  searchToSql,
} from './leads.sql-helpers.js';

/**
 * Data access for leads.
 *
 * Only the leads service calls this. No other module may: a module reaching
 * into another's repository is the boundary violation that makes the monolith
 * impossible to split later (ADR-0001).
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
  /** The searchable columns the actor may read; `search` looks in these and no others. */
  readonly searchFields?: readonly string[] | undefined;
  readonly fields: readonly FieldDefinition[];
}

export interface ListResult {
  readonly rows: (Lead & { cursorValue: string | null })[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

@Injectable()
export class LeadsRepository {
  async list(tx: Tx, tenantId: string, options: ListOptions): Promise<ListResult> {
    const sortField = options.sort?.field ?? 'created_at';
    const direction = options.sort?.direction ?? 'asc';
    const sortExpression = expressionForField(sortField, options.fields);

    const predicates: SQL[] = [eq(leads.tenantId, tenantId), notDeleted()];

    const scope = constraintToSql(options.constraint);
    if (scope !== undefined) predicates.push(scope);

    for (const filter of options.filters) {
      predicates.push(filterToSql(filter, options.fields));
    }

    if (options.search !== undefined && options.search.length > 0) {
      predicates.push(searchToSql(options.search, options.searchFields ?? []));
    }

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null) {
      predicates.push(keysetPredicate(sortExpression, sql`${leads.id}`, direction, cursor));
    }

    // One row more than asked for, so "is there another page" needs no count.
    //
    // The sort value is rendered to text **by Postgres** and carried in the
    // cursor verbatim. Deriving it from the returned JavaScript value loses
    // precision — a timestamptz has microseconds and a JS Date has only
    // milliseconds — so the next page's "strictly after" comparison would
    // include the boundary row again and the caller would see duplicates.
    const rows = await tx
      .select({
        ...getTableColumns(leads),
        cursorValue: sql<string | null>`(${sortExpression})::text`,
      })
      .from(leads)
      .where(and(...predicates))
      .orderBy(
        direction === 'asc' ? asc(sortExpression) : desc(sortExpression),
        direction === 'asc' ? asc(leads.id) : desc(leads.id),
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

  /**
   * The rows among `ids` this reader may see.
   *
   * `constraint` is the reader's record scope, applied here in SQL rather
   * than by filtering afterwards: a record outside their scope is never
   * fetched, so it cannot be named, counted or hinted at. Batched because an
   * activity list resolves every link on the page at once, and one query per
   * link would be fifty queries per page.
   */
  async findReadableMany(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
    constraint: RecordConstraint,
  ): Promise<Lead[]> {
    if (ids.length === 0) return [];
    const predicates: SQL[] = [
      eq(leads.tenantId, tenantId),
      inArray(leads.id, [...ids]),
      notDeleted(),
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);
    return tx
      .select()
      .from(leads)
      .where(and(...predicates));
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<Lead | null> {
    const rows = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id), notDeleted()))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(tx: Tx, values: typeof leads.$inferInsert): Promise<Lead> {
    const rows = await tx.insert(leads).values(values).returning();
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
    patch: Partial<typeof leads.$inferInsert>,
  ): Promise<Lead | null> {
    const rows = await tx
      .update(leads)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(leads.tenantId, tenantId),
          eq(leads.id, id),
          eq(leads.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Soft delete, so the record can be restored from the Recycle Bin. */
  async softDelete(
    tx: Tx,
    tenantId: string,
    id: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<Lead | null> {
    const rows = await tx
      .update(leads)
      .set({ deletedAt: new Date(), updatedBy: actorId, version: expectedVersion + 1 })
      .where(
        and(
          eq(leads.tenantId, tenantId),
          eq(leads.id, id),
          eq(leads.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Convert a lead: the one write that sets status, `converted_at` and the
   * three links, guarded by the version the caller read.
   *
   * `status <> 'converted'` is in the WHERE clause as well as the trigger's
   * refusal underneath it: two conversions racing for the same lead cannot
   * both match, so the loser gets null — a 409 — instead of re-pointing the
   * links the winner just wrote (ADR-0022).
   */
  async markConverted(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    values: {
      readonly convertedAt: Date;
      readonly convertedContactId: string;
      readonly convertedAccountId: string | null;
      readonly convertedDealId: string | null;
      readonly updatedBy: string;
    },
  ): Promise<Lead | null> {
    const rows = await tx
      .update(leads)
      .set({
        status: 'converted',
        ...values,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(leads.tenantId, tenantId),
          eq(leads.id, id),
          eq(leads.version, expectedVersion),
          not(eq(leads.status, 'converted')),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Live leads a new or edited lead might duplicate, by exact email or phone
   * (ADR-0023). `constraint` is the reader's record scope, applied in SQL, so
   * a lead the actor may not read is never fetched. Converted leads are
   * included on purpose: "this person already became a customer" is the most
   * useful thing a duplicate prompt can say.
   */
  async findDuplicates(
    tx: Tx,
    tenantId: string,
    criteria: {
      readonly email?: string | undefined;
      readonly phone?: string | undefined;
      readonly excludeId?: string | undefined;
    },
    constraint: RecordConstraint,
    limit: number,
  ): Promise<Lead[]> {
    const matches: SQL[] = [];
    if (criteria.email !== undefined) matches.push(emailIs(criteria.email));
    if (criteria.phone !== undefined) matches.push(eq(leads.phone, criteria.phone));
    if (matches.length === 0) return [];

    const predicates: SQL[] = [eq(leads.tenantId, tenantId), notDeleted(), or(...matches)!];
    if (criteria.excludeId !== undefined) predicates.push(not(eq(leads.id, criteria.excludeId)));
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    return tx
      .select()
      .from(leads)
      .where(and(...predicates))
      .orderBy(asc(leads.createdAt), asc(leads.id))
      .limit(limit);
  }

  /**
   * Open leads grouped by source, most common first.
   *
   * "Open" is every current lead that is not converted: a converted lead is a
   * contact now and is counted there. Sources are compared case-insensitively
   * and without surrounding spaces, because they are typed by people ("Website",
   * "website ") and a chart with three bars for one source is a wrong chart; the
   * label shown is one of the spellings. A blank source is the `null` group.
   *
   * The scope is in the WHERE clause, so a breakdown never counts a lead the
   * reader could not open.
   */
  async countsBySource(
    tx: Tx,
    tenantId: string,
    constraint: RecordConstraint,
  ): Promise<{ source: string | null; count: number }[]> {
    const predicates: SQL[] = [
      eq(leads.tenantId, tenantId),
      notDeleted(),
      sql`${leads.status} <> 'converted'`,
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    const key = sql`nullif(lower(btrim(${leads.source})), '')`;
    const rows = await tx
      .select({
        source: sql<string | null>`nullif(min(btrim(${leads.source})), '')`,
        count: sql<number>`count(*)::int`,
      })
      .from(leads)
      .where(and(...predicates))
      .groupBy(sql`${key}`)
      .orderBy(sql`count(*) desc`, sql`${key} asc nulls last`);

    return rows.map((row) => ({ source: row.source, count: row.count }));
  }
}
