import { Injectable } from '@nestjs/common';
import {
  and,
  dataExportJobs,
  desc,
  eq,
  getTableColumns,
  erasureRequests,
  sql,
  type DataExportJob,
  type ErasureRequest,
  type NewDataExportJob,
  type NewErasureRequest,
  type Tx,
} from '@crm/db';

/**
 * Data access for archives and erasure requests (MVP_SPEC M11).
 *
 * Archives are looked up **by creator as well as by id**, like every other
 * generated file in this system: a whole-tenant archive is the most dangerous
 * object the product can produce, and only the person who asked for it has any
 * claim to it. An Owner cannot fetch another Owner's archive link.
 *
 * Erasure requests are not: they are the workspace's compliance record, readable
 * by anyone holding the capability, which is the point of keeping them.
 */
@Injectable()
export class DataRightsRepository {
  /** Null when the idempotency key already names a job. */
  async insertExport(tx: Tx, values: NewDataExportJob): Promise<DataExportJob | null> {
    const rows = await tx.insert(dataExportJobs).values(values).onConflictDoNothing().returning();
    return rows[0] ?? null;
  }

  async findOwnExport(
    tx: Tx,
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<DataExportJob | null> {
    const rows = await tx
      .select()
      .from(dataExportJobs)
      .where(
        and(
          eq(dataExportJobs.tenantId, tenantId),
          eq(dataExportJobs.createdBy, userId),
          eq(dataExportJobs.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findExportByIdempotencyKey(
    tx: Tx,
    tenantId: string,
    userId: string,
    key: string,
  ): Promise<DataExportJob | null> {
    const rows = await tx
      .select()
      .from(dataExportJobs)
      .where(
        and(
          eq(dataExportJobs.tenantId, tenantId),
          eq(dataExportJobs.createdBy, userId),
          eq(dataExportJobs.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record an erasure request.
   *
   * `onConflictDoNothing` against `erasure_requests_one_in_flight`: a second
   * request for a subject already being erased returns null, and the service
   * turns that into a 409 rather than queueing a duplicate. The database is
   * what decides, not a read-then-write in the service, because two concurrent
   * requests would both pass the read.
   */
  async insertErasure(tx: Tx, values: NewErasureRequest): Promise<ErasureRequest | null> {
    const rows = await tx.insert(erasureRequests).values(values).onConflictDoNothing().returning();
    return rows[0] ?? null;
  }

  async findErasure(tx: Tx, tenantId: string, id: string): Promise<ErasureRequest | null> {
    const rows = await tx
      .select()
      .from(erasureRequests)
      .where(and(eq(erasureRequests.tenantId, tenantId), eq(erasureRequests.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Keyset on `(created_at desc, id desc)` — `erasure_requests_tenant_created_idx`.
   *
   * The cursor value comes back as **Postgres** rendered it, not as
   * `createdAt.toISOString()`: a timestamptz holds microseconds and a JavaScript
   * Date holds milliseconds, so a truncated cursor is earlier than the row it
   * came from and the next page skips everything in between (ADR-0012).
   */
  async listErasures(
    tx: Tx,
    tenantId: string,
    limit: number,
    cursor: { readonly value: string | null; readonly id: string } | null,
  ): Promise<(ErasureRequest & { cursorValue: string })[]> {
    const where = [eq(erasureRequests.tenantId, tenantId)];
    if (cursor !== null && cursor.value !== null) {
      where.push(
        sql`(${erasureRequests.createdAt}, ${erasureRequests.id}) < (${cursor.value}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    return tx
      .select({
        ...getTableColumns(erasureRequests),
        cursorValue: sql<string>`${erasureRequests.createdAt}::text`.as('cursor_value'),
      })
      .from(erasureRequests)
      .where(and(...where))
      .orderBy(desc(erasureRequests.createdAt), desc(erasureRequests.id))
      .limit(limit);
  }
}