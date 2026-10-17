import { Injectable } from '@nestjs/common';
import type { FieldDefinition, RecordConstraint } from '@crm/core';
import type { ParsedFilter, SortDirection } from '@crm/contracts';
import {
  contacts,
  type Contact,
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
} from './contacts.sql-helpers.js';

/**
 * Data access for contacts.
 *
 * Only the contacts service calls this. No other module may: a module reaching
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
  readonly fields: readonly FieldDefinition[];
}

export interface ListResult {
  readonly rows: (Contact & { cursorValue: string | null })[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

@Injectable()
export class ContactsRepository {
  async list(tx: Tx, tenantId: string, options: ListOptions): Promise<ListResult> {
    const sortField = options.sort?.field ?? 'created_at';
    const direction = options.sort?.direction ?? 'asc';
    const sortExpression = expressionForField(sortField, options.fields);

    const predicates: SQL[] = [eq(contacts.tenantId, tenantId), notDeleted()];

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
      predicates.push(keysetPredicate(sortExpression, sql`${contacts.id}`, direction, cursor));
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
        ...getTableColumns(contacts),
        cursorValue: sql<string | null>`(${sortExpression})::text`,
      })
      .from(contacts)
      .where(and(...predicates))
      .orderBy(
        direction === 'asc' ? asc(sortExpression) : desc(sortExpression),
        direction === 'asc' ? asc(contacts.id) : desc(contacts.id),
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

  async findById(tx: Tx, tenantId: string, id: string): Promise<Contact | null> {
    const rows = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id), notDeleted()))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(tx: Tx, values: typeof contacts.$inferInsert): Promise<Contact> {
    const rows = await tx.insert(contacts).values(values).returning();
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
    patch: Partial<typeof contacts.$inferInsert>,
  ): Promise<Contact | null> {
    const rows = await tx
      .update(contacts)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, id),
          eq(contacts.version, expectedVersion),
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
  ): Promise<Contact | null> {
    const rows = await tx
      .update(contacts)
      .set({ deletedAt: new Date(), updatedBy: actorId, version: expectedVersion + 1 })
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, id),
          eq(contacts.version, expectedVersion),
          notDeleted(),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Which of these ids are live contacts in this tenant. */
  async existingIds(tx: Tx, tenantId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, [...ids]), notDeleted()));
    return new Set(rows.map((row) => row.id));
  }

  /** Live contacts in this tenant with the same email, for duplicate detection. */
  async findByEmail(tx: Tx, tenantId: string, email: string): Promise<Contact[]> {
    return tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, email), notDeleted()))
      .limit(5);
  }
}
