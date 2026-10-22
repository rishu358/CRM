import { Injectable } from '@nestjs/common';
import type { FieldDefinition, LinkTargetType, RecordConstraint } from '@crm/core';
import type { ParsedFilter, SortDirection } from '@crm/contracts';
import {
  activities,
  activityLinks,
  type Activity,
  type ActivityLink,
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
} from './activities.sql-helpers.js';

/**
 * Data access for activities and their polymorphic links.
 *
 * Only the activities service calls this. Every query runs inside the
 * caller's tenant-scoped transaction, so RLS adds the tenant predicate; the
 * explicit `tenant_id` comparisons here are belt and braces, not the actual
 * isolation.
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
  /** "The activities on this record", as a record page asks for them. */
  readonly linkedTo?: { objectType: LinkTargetType; recordId: string } | undefined;
  readonly status?: 'open' | 'completed' | 'cancelled' | undefined;
  readonly assignedTo?: string | undefined;
}

export interface ListResult {
  readonly rows: (Activity & { cursorValue: string | null })[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** The three My Day buckets, fetched in the viewer's own day boundaries. */
export interface MyDayWindow {
  readonly assigneeId: string;
  readonly startOfDay: Date;
  readonly endOfDay: Date;
  readonly upcomingEnd: Date;
  readonly limit: number;
}

@Injectable()
export class ActivitiesRepository {
  async list(tx: Tx, tenantId: string, options: ListOptions): Promise<ListResult> {
    const sortField = options.sort?.field ?? 'created_at';
    const direction = options.sort?.direction ?? 'desc';
    const sortExpression = expressionForField(sortField, options.fields);

    const predicates: SQL[] = [eq(activities.tenantId, tenantId), notDeleted()];

    const scope = constraintToSql(options.constraint);
    if (scope !== undefined) predicates.push(scope);

    if (options.status !== undefined) predicates.push(eq(activities.status, options.status));
    if (options.assignedTo !== undefined) {
      predicates.push(eq(activities.assignedTo, options.assignedTo));
    }

    if (options.linkedTo !== undefined) {
      // EXISTS rather than a join: an activity linked to the same record
      // twice cannot happen (the unique index forbids it), but an activity
      // with several links would still multiply rows under a join and break
      // the keyset page size.
      predicates.push(sql`exists (
        select 1 from ${activityLinks} al
        where al.tenant_id = ${tenantId}
          and al.activity_id = ${activities.id}
          and al.object_type = ${options.linkedTo.objectType}
          and al.record_id = ${options.linkedTo.recordId}
      )`);
    }

    for (const filter of options.filters) {
      predicates.push(filterToSql(filter, options.fields));
    }

    if (options.search !== undefined && options.search.length > 0) {
      predicates.push(searchToSql(options.search, options.searchFields ?? []));
    }

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null) {
      predicates.push(keysetPredicate(sortExpression, sql`${activities.id}`, direction, cursor));
    }

    // One row more than asked for, so "is there another page" needs no count.
    // The sort value is rendered to text by Postgres and carried in the
    // cursor verbatim; see the note in the contacts repository for why
    // deriving it from the JavaScript value loses precision.
    const rows = await tx
      .select({
        ...getTableColumns(activities),
        cursorValue: sql<string | null>`(${sortExpression})::text`,
      })
      .from(activities)
      .where(and(...predicates))
      .orderBy(
        direction === 'asc' ? asc(sortExpression) : desc(sortExpression),
        direction === 'asc' ? asc(activities.id) : desc(activities.id),
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
   * The open work assigned to one person, split into the three My Day
   * buckets (MVP_SPEC M6).
   *
   * The boundaries arrive as absolute instants computed from the viewer's
   * time zone by `@crm/core/activities`, so the comparison here is plain
   * `timestamptz` arithmetic and the time-zone logic has exactly one home.
   */
  async myDay(
    tx: Tx,
    tenantId: string,
    window: MyDayWindow,
  ): Promise<{ overdue: Activity[]; dueToday: Activity[]; upcoming: Activity[] }> {
    const base = [
      eq(activities.tenantId, tenantId),
      notDeleted(),
      eq(activities.status, 'open'),
      eq(activities.assignedTo, window.assigneeId),
    ];

    const inRange = async (from: Date | null, to: Date): Promise<Activity[]> => {
      const range: SQL[] = [sql`${activities.dueAt} is not null`, sql`${activities.dueAt} < ${to}`];
      // Overdue has no lower bound: a task from last month is still overdue.
      if (from !== null) range.push(sql`${activities.dueAt} >= ${from}`);

      return tx
        .select()
        .from(activities)
        .where(and(...base, ...range))
        .orderBy(asc(activities.dueAt), asc(activities.id))
        .limit(window.limit);
    };

    return {
      overdue: await inRange(null, window.startOfDay),
      dueToday: await inRange(window.startOfDay, window.endOfDay),
      upcoming: await inRange(window.endOfDay, window.upcomingEnd),
    };
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<Activity | null> {
    const rows = await tx
      .select()
      .from(activities)
      .where(and(eq(activities.tenantId, tenantId), eq(activities.id, id), notDeleted()))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The activities among `ids` this reader may see.
   *
   * `constraint` is the reader's record scope, applied here in SQL rather than
   * by filtering afterwards: an activity outside their scope is never fetched,
   * so it cannot be named, counted or hinted at. Batched because global search
   * resolves a whole page of hits at once (ADR-0028), and one query per hit
   * would be a query per keystroke per result.
   */
  async findReadableMany(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
    constraint: RecordConstraint,
  ): Promise<Activity[]> {
    if (ids.length === 0) return [];
    const predicates: SQL[] = [
      eq(activities.tenantId, tenantId),
      inArray(activities.id, [...ids]),
      notDeleted(),
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);
    return tx
      .select()
      .from(activities)
      .where(and(...predicates));
  }

  async insert(tx: Tx, values: typeof activities.$inferInsert): Promise<Activity> {
    const rows = await tx.insert(activities).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Update guarded by the version the caller read.
   *
   * The version is part of the WHERE clause, so a concurrent edit matches
   * zero rows rather than overwriting. Returning null lets the service raise
   * 409 instead of silently clobbering a colleague's work.
   */
  async updateWithVersion(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof activities.$inferInsert>,
  ): Promise<Activity | null> {
    const rows = await tx
      .update(activities)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(activities.tenantId, tenantId),
          eq(activities.id, id),
          eq(activities.version, expectedVersion),
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
  ): Promise<Activity | null> {
    const rows = await tx
      .update(activities)
      .set({ deletedAt: new Date(), updatedBy: actorId, version: expectedVersion + 1 })
      .where(
        and(
          eq(activities.tenantId, tenantId),
          eq(activities.id, id),
          eq(activities.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Links (ADR-0005)
  // -------------------------------------------------------------------------

  async insertLink(tx: Tx, values: typeof activityLinks.$inferInsert): Promise<void> {
    // Linking the same record twice is the same fact, not an error: the
    // unique index makes the second one a no-op rather than a 409 the user
    // would have to understand.
    await tx.insert(activityLinks).values(values).onConflictDoNothing();
  }

  async deleteLink(
    tx: Tx,
    tenantId: string,
    activityId: string,
    objectType: LinkTargetType,
    recordId: string,
  ): Promise<boolean> {
    const rows = await tx
      .delete(activityLinks)
      .where(
        and(
          eq(activityLinks.tenantId, tenantId),
          eq(activityLinks.activityId, activityId),
          eq(activityLinks.objectType, objectType),
          eq(activityLinks.recordId, recordId),
        ),
      )
      .returning({ id: activityLinks.id });
    return rows.length > 0;
  }

  /** Every link on these activities, for resolving a whole page at once. */
  async linksFor(
    tx: Tx,
    tenantId: string,
    activityIds: readonly string[],
  ): Promise<ActivityLink[]> {
    if (activityIds.length === 0) return [];
    return tx
      .select()
      .from(activityLinks)
      .where(
        and(
          eq(activityLinks.tenantId, tenantId),
          inArray(activityLinks.activityId, [...activityIds]),
        ),
      )
      .orderBy(asc(activityLinks.objectType), asc(activityLinks.recordId));
  }

  /**
   * Is this user someone the actor may hand work to?
   *
   * Active membership of the tenant is the floor. `team` scope additionally
   * requires a shared team, so a manager can assign within their team and a
   * rep with `own` scope cannot push work onto a colleague.
   */
  async isAssignable(
    tx: Tx,
    tenantId: string,
    userId: string,
    teamIds: readonly string[] | null,
  ): Promise<boolean> {
    const teamPredicate =
      teamIds === null
        ? sql`true`
        : teamIds.length === 0
          ? sql`false`
          : sql`exists (
              select 1 from team_members tm
              where tm.tenant_id = ${tenantId}
                and tm.user_id = ${userId}
                and tm.team_id in (${sql.join(
                  teamIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
            )`;

    const result = await tx.execute(sql`
      select 1 as ok
      from memberships m
      where m.tenant_id = ${tenantId}
        and m.user_id = ${userId}
        and m.status = 'active'
        and ${teamPredicate}
      limit 1
    `);
    return result.rows.length > 0;
  }

  /** The viewer's own display preferences, for day boundaries (ADR-0011). */
  async userPreferences(
    tx: Tx,
    userId: string,
  ): Promise<{ timezone: string; locale: string } | null> {
    const result = await tx.execute(sql`
      select timezone, locale from users where id = ${userId} limit 1
    `);
    const row = (result.rows as unknown as { timezone: string; locale: string }[])[0];
    return row ?? null;
  }

  /**
   * Open tasks whose due time has passed, oldest first, and how many there are.
   *
   * "Passed" is the database's `now()`, the same instant for every statement of
   * the request, not a `Date` from whichever machine the API runs on. Unlike My
   * Day this is not cut on anybody's calendar day: a task due at 09:00 is overdue
   * at 15:00 the same day, which is what a team-wide count has to mean.
   *
   * The scope is in the WHERE clause, so both the count and the rows are what the
   * reader could list, and no more.
   */
  async overdueTasks(
    tx: Tx,
    tenantId: string,
    constraint: RecordConstraint,
    limit: number,
  ): Promise<{ count: number; rows: Activity[] }> {
    const predicates: SQL[] = [
      eq(activities.tenantId, tenantId),
      notDeleted(),
      eq(activities.type, 'task'),
      eq(activities.status, 'open'),
      sql`${activities.dueAt} < now()`,
    ];
    const scope = constraintToSql(constraint);
    if (scope !== undefined) predicates.push(scope);

    const counted = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(activities)
      .where(and(...predicates));

    const rows = await tx
      .select()
      .from(activities)
      .where(and(...predicates))
      .orderBy(asc(activities.dueAt), asc(activities.id))
      .limit(limit);

    return { count: counted[0]?.count ?? 0, rows };
  }
}
