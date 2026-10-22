import { Injectable } from '@nestjs/common';
import type { FieldDefinition, RecordConstraint } from '@crm/core';
import type { ParsedFilter, SortDirection } from '@crm/contracts';
import {
  dealContacts,
  deals,
  type Deal,
  type Tx,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
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
} from './deals.sql-helpers.js';
import type { DealPerson } from './deals.serializer.js';

/**
 * Data access for deals.
 *
 * Only the deals service calls this. No other module may: a module reaching
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
  readonly rows: (Deal & { cursorValue: string | null })[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * A calendar month in the company's time zone, as the instants that bound it.
 *
 * Computed by the database from its own clock, never from the API process's
 * `Date`: two requests a moment apart must agree about which month it is, and
 * the machines the API runs on do not agree about what time it is (ADR-0038).
 */
export interface MonthWindow {
  readonly start: Date;
  readonly end: Date;
  readonly previousStart: Date;
}

/** Deals won in the current or the previous month, per owner and currency. */
export interface WonCell {
  readonly ownerId: string | null;
  readonly period: 'current' | 'previous';
  readonly currency: string | null;
  readonly count: number;
  readonly withAmount: number;
  readonly amountMinor: bigint;
}

/** One stage-and-currency cell of the board's totals. */
export interface BoardCell {
  readonly stageId: string;
  /** Null for deals with no amount. */
  readonly currency: string | null;
  readonly count: number;
  /** Deals in this cell that carry an amount. */
  readonly withAmount: number;
  readonly amountMinor: bigint;
}

@Injectable()
export class DealsRepository {
  async list(tx: Tx, tenantId: string, options: ListOptions): Promise<ListResult> {
    const sortField = options.sort?.field ?? 'created_at';
    const direction = options.sort?.direction ?? 'asc';
    const sortExpression = expressionForField(sortField, options.fields);

    const predicates: SQL[] = [eq(deals.tenantId, tenantId), notDeleted()];

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
      predicates.push(keysetPredicate(sortExpression, sql`${deals.id}`, direction, cursor));
    }

    // One row more than asked for, so "is there another page" needs no count.
    // The sort value is rendered to text by Postgres and carried in the cursor
    // verbatim: deriving it from a JavaScript value loses a timestamptz's
    // microseconds and the next page would repeat the boundary row.
    const rows = await tx
      .select({
        ...getTableColumns(deals),
        cursorValue: sql<string | null>`(${sortExpression})::text`,
      })
      .from(deals)
      .where(and(...predicates))
      .orderBy(
        direction === 'asc' ? asc(sortExpression) : desc(sortExpression),
        direction === 'asc' ? asc(deals.id) : desc(deals.id),
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
  ): Promise<Deal[]> {
    if (ids.length === 0) return [];
    const predicates: SQL[] = [
      eq(deals.tenantId, tenantId),
      inArray(deals.id, [...ids]),
      notDeleted(),
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);
    return tx
      .select()
      .from(deals)
      .where(and(...predicates));
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<Deal | null> {
    const rows = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id), notDeleted()))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(tx: Tx, values: typeof deals.$inferInsert): Promise<Deal> {
    const rows = await tx.insert(deals).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Update guarded by the version the caller read.
   *
   * The version is part of the WHERE clause, so a concurrent edit — or a
   * second drag of a card somebody else just moved — matches zero rows rather
   * than overwriting. Returning null lets the service raise 409.
   */
  async updateWithVersion(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof deals.$inferInsert>,
  ): Promise<Deal | null> {
    const rows = await tx
      .update(deals)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.id, id),
          eq(deals.version, expectedVersion),
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
  ): Promise<Deal | null> {
    const rows = await tx
      .update(deals)
      .set({
        deletedAt: new Date(),
        updatedBy: actorId,
        updatedAt: new Date(),
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.id, id),
          eq(deals.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** The people on each of these deals, in one query. */
  async peopleFor(
    tx: Tx,
    tenantId: string,
    dealIds: readonly string[],
  ): Promise<Map<string, DealPerson[]>> {
    const byDeal = new Map<string, DealPerson[]>();
    if (dealIds.length === 0) return byDeal;

    const rows = await tx
      .select({
        dealId: dealContacts.dealId,
        contactId: dealContacts.contactId,
        role: dealContacts.role,
      })
      .from(dealContacts)
      .where(and(eq(dealContacts.tenantId, tenantId), inArray(dealContacts.dealId, [...dealIds])))
      .orderBy(asc(dealContacts.createdAt), asc(dealContacts.id));

    for (const row of rows) {
      const list = byDeal.get(row.dealId) ?? [];
      list.push({ contactId: row.contactId, role: row.role });
      byDeal.set(row.dealId, list);
    }
    return byDeal;
  }

  /** Replace the whole set of people on a deal. */
  async replacePeople(
    tx: Tx,
    tenantId: string,
    dealId: string,
    people: readonly { id: string; contactId: string; role: string | null }[],
    actorId: string,
  ): Promise<void> {
    await tx
      .delete(dealContacts)
      .where(and(eq(dealContacts.tenantId, tenantId), eq(dealContacts.dealId, dealId)));

    if (people.length === 0) return;

    await tx.insert(dealContacts).values(
      people.map((person) => ({
        id: person.id,
        tenantId,
        dealId,
        contactId: person.contactId,
        role: person.role,
        createdBy: actorId,
        updatedBy: actorId,
      })),
    );
  }

  /**
   * Count and amount per stage and currency, for the board's column totals.
   *
   * Aggregated in the database over **every** deal in the pipeline that the
   * actor's scope admits — not over the cards a page happened to load — so a
   * column's total does not change as the user scrolls. The scope is in the
   * WHERE clause for the same reason it is on the list: a total that included
   * a colleague's deals would disclose them.
   */
  async boardCells(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    constraint: RecordConstraint,
  ): Promise<BoardCell[]> {
    const predicates: SQL[] = [
      eq(deals.tenantId, tenantId),
      eq(deals.pipelineId, pipelineId),
      notDeleted(),
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    const rows = await tx
      .select({
        stageId: deals.stageId,
        currency: deals.currency,
        count: sql<number>`count(*)::int`,
        withAmount: sql<number>`count(${deals.amountMinor})::int`,
        amountMinor: sql<string>`coalesce(sum(${deals.amountMinor}), 0)::text`,
      })
      .from(deals)
      .where(and(...predicates))
      .groupBy(deals.stageId, deals.currency);

    return rows.map((row) => ({
      stageId: row.stageId,
      currency: row.currency,
      count: row.count,
      withAmount: row.withAmount,
      amountMinor: BigInt(row.amountMinor),
    }));
  }

  /**
   * This month and the one before, in the company's time zone.
   *
   * `now()` is the database's transaction time, so every statement of one
   * request sees the same instant. The zone is a bound parameter and has already
   * been checked against the IANA list by the caller.
   *
   * `instant` exists so a test can ask what the window was at a moment near a month
   * boundary, which the real clock cannot be made to be. Production never passes it.
   */
  async monthWindow(tx: Tx, timeZone: string, instant?: Date): Promise<MonthWindow> {
    const at = instant === undefined ? sql`now()` : sql`${instant.toISOString()}::timestamptz`;
    const local = sql`date_trunc('month', timezone(${timeZone}, ${at}))`;
    const result = await tx.execute<{ start: Date; end: Date; previous_start: Date }>(sql`
      select
        timezone(${timeZone}, ${local}) as start,
        timezone(${timeZone}, ${local} + interval '1 month') as "end",
        timezone(${timeZone}, ${local} - interval '1 month') as previous_start
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Month window returned no row');
    return {
      start: new Date(row.start),
      end: new Date(row.end),
      previousStart: new Date(row.previous_start),
    };
  }

  /**
   * Deals won since the start of last month, per owner, currency and month.
   *
   * "Won" is membership of a won stage, which the pipelines module names
   * (`wonStageIds`); `closed_at` is when the stage put it there. The scope is in
   * the WHERE clause, as on the list, so a total can never include a colleague's
   * deal the caller could not open.
   */
  async wonCells(
    tx: Tx,
    tenantId: string,
    constraint: RecordConstraint,
    wonStageIds: readonly string[],
    window: MonthWindow,
  ): Promise<WonCell[]> {
    if (wonStageIds.length === 0) return [];

    const predicates: SQL[] = [
      eq(deals.tenantId, tenantId),
      notDeleted(),
      inArray(deals.stageId, [...wonStageIds]),
      sql`${deals.closedAt} >= ${window.previousStart.toISOString()}::timestamptz`,
      sql`${deals.closedAt} < ${window.end.toISOString()}::timestamptz`,
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    const period = sql<
      'current' | 'previous'
    >`case when ${deals.closedAt} >= ${window.start.toISOString()}::timestamptz then 'current' else 'previous' end`;

    const rows = await tx
      .select({
        ownerId: deals.ownerId,
        period,
        currency: deals.currency,
        count: sql<number>`count(*)::int`,
        withAmount: sql<number>`count(${deals.amountMinor})::int`,
        amountMinor: sql<string>`coalesce(sum(${deals.amountMinor}), 0)::text`,
      })
      .from(deals)
      .where(and(...predicates))
      // By position: the period expression carries bound parameters, and the same
      // text with different parameter numbers is not "the same expression" to Postgres.
      .groupBy(sql`1, 2, 3`);

    return rows.map((row) => ({
      ownerId: row.ownerId,
      period: row.period,
      currency: row.currency,
      count: row.count,
      withAmount: row.withAmount,
      amountMinor: BigInt(row.amountMinor),
    }));
  }
}
