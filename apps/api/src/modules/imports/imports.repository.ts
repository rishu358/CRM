import { Injectable } from '@nestjs/common';
import {
  importJobs,
  type ImportJob,
  type NewImportJob,
  type Tx,
  and,
  desc,
  eq,
  sql,
} from '@crm/db';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';

/**
 * Data access for import jobs.
 *
 * Every read is by `created_by` as well as by id. RLS already confines a query
 * to the tenant; this narrows it to the person who started the job, because a
 * job's mapping, preview rows and error file are the contents of somebody's
 * spreadsheet and nobody else on the team has a reason to see them. A job that
 * is someone else's is, from here, a job that does not exist (CLAUDE.md §5.5).
 */
export interface ImportListResult {
  readonly rows: ImportJob[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

@Injectable()
export class ImportsRepository {
  /** Returns null when the idempotency key already names a job (a retry won the race). */
  async insert(tx: Tx, values: NewImportJob): Promise<ImportJob | null> {
    const rows = await tx.insert(importJobs).values(values).onConflictDoNothing().returning();
    return rows[0] ?? null;
  }

  async findOwn(tx: Tx, tenantId: string, userId: string, id: string): Promise<ImportJob | null> {
    const rows = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.tenantId, tenantId),
          eq(importJobs.createdBy, userId),
          eq(importJobs.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findByIdempotencyKey(
    tx: Tx,
    tenantId: string,
    userId: string,
    key: string,
  ): Promise<ImportJob | null> {
    const rows = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.tenantId, tenantId),
          eq(importJobs.createdBy, userId),
          eq(importJobs.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listOwn(
    tx: Tx,
    tenantId: string,
    userId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<ImportListResult> {
    // A check is not an import: it is shown with the import it belongs to, not in the recent list.
    const predicates = [
      eq(importJobs.tenantId, tenantId),
      eq(importJobs.createdBy, userId),
      eq(importJobs.dryRun, false),
    ];

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null && cursor.value !== null) {
      // Newest first, so "after" the cursor means strictly older.
      predicates.push(
        sql`((${importJobs.createdAt}, ${importJobs.id}) < (${cursor.value}::timestamptz, ${cursor.id}::uuid))`,
      );
    }

    const rows = await tx
      .select()
      .from(importJobs)
      .where(and(...predicates))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(options.limit + 1);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    // The timestamp is rendered by Postgres, not by JavaScript: a Date holds
    // milliseconds and the column holds microseconds, so a JS-built cursor would
    // re-include the boundary row on the next page (the same trap ADR-0012 notes).
    let nextCursor: string | null = null;
    if (hasMore && last !== undefined) {
      const text = await tx.execute(
        sql`select ${importJobs.createdAt}::text as value from ${importJobs} where ${importJobs.id} = ${last.id}`,
      );
      const value = (text.rows[0] as { value: string } | undefined)?.value ?? null;
      nextCursor = encodeCursor({ value, id: last.id });
    }

    return { rows: page, hasMore, nextCursor };
  }

  /**
   * Move a job along, only if it is still where the caller thinks it is.
   *
   * The status is in the WHERE clause, so two clicks on "Start" cannot both
   * win: the second matches zero rows and the caller re-reads. The database
   * trigger independently refuses an edge the state machine does not have
   * (`0012_import_export.sql`).
   */
  async transition(
    tx: Tx,
    tenantId: string,
    id: string,
    from: ImportJob['status'],
    patch: Partial<NewImportJob>,
  ): Promise<ImportJob | null> {
    const rows = await tx
      .update(importJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(importJobs.tenantId, tenantId), eq(importJobs.id, id), eq(importJobs.status, from)),
      )
      .returning();
    return rows[0] ?? null;
  }
}
