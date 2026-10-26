import { Injectable } from '@nestjs/common';
import type { BusinessObjectType, ViewVisibility } from '@crm/core';
import { savedViews, type SavedView, type Tx, and, asc, eq, sql } from '@crm/db';

/**
 * Data access for saved views.
 *
 * Who may see a row is not decided here: the restrictive policies of migration 0023 narrow every
 * SELECT to private-and-mine, team-shared-with-me and tenant-wide, whatever this file asks for. So
 * `list` and `findById` return what the caller may see and nothing else, and the service never has
 * to remember a visibility predicate. The writes below add `created_by = userId` anyway: the
 * policies refuse a write to somebody else's view, and a statement that names the same rule fails
 * as "no row" instead of as a database error.
 */
@Injectable()
export class SavedViewsRepository {
  async list(tx: Tx, tenantId: string, objectType: BusinessObjectType): Promise<SavedView[]> {
    return tx
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.tenantId, tenantId), eq(savedViews.objectType, objectType)))
      .orderBy(asc(sql`lower(${savedViews.name})`), asc(savedViews.id));
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<SavedView | null> {
    const rows = await tx
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.tenantId, tenantId), eq(savedViews.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async countOwn(
    tx: Tx,
    tenantId: string,
    userId: string,
    objectType: BusinessObjectType,
  ): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(savedViews)
      .where(
        and(
          eq(savedViews.tenantId, tenantId),
          eq(savedViews.createdBy, userId),
          eq(savedViews.objectType, objectType),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  async insert(tx: Tx, values: typeof savedViews.$inferInsert): Promise<SavedView> {
    const rows = await tx.insert(savedViews).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /** Version-guarded; null when somebody saved first (or the view is not the caller's). */
  async updateWithVersion(
    tx: Tx,
    tenantId: string,
    userId: string,
    id: string,
    version: number,
    patch: {
      name?: string;
      visibility?: ViewVisibility;
      filters?: Record<string, unknown>;
      columns?: readonly string[];
      sort?: readonly Record<string, unknown>[];
      updatedBy: string;
    },
  ): Promise<SavedView | null> {
    const rows = await tx
      .update(savedViews)
      .set({ ...patch, version: version + 1, updatedAt: new Date() })
      .where(
        and(
          eq(savedViews.tenantId, tenantId),
          eq(savedViews.id, id),
          eq(savedViews.createdBy, userId),
          eq(savedViews.version, version),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** A hard delete: a view is configuration, not a record, and has no Recycle Bin. */
  async deleteWithVersion(
    tx: Tx,
    tenantId: string,
    userId: string,
    id: string,
    version: number,
  ): Promise<boolean> {
    const rows = await tx
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.tenantId, tenantId),
          eq(savedViews.id, id),
          eq(savedViews.createdBy, userId),
          eq(savedViews.version, version),
        ),
      )
      .returning({ id: savedViews.id });
    return rows.length > 0;
  }
}
