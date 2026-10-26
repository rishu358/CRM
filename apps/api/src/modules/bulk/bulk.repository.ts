import { Injectable } from '@nestjs/common';
import { bulkOperations, type BulkOperationRow, type Tx, and, eq, lt, sql } from '@crm/db';

/** How long a bulk action's Idempotency-Key is remembered. */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Data access for `bulk_operations`, the remembered answers to retried bulk actions
 * (migration 0023, ADR-0056). A person only ever reads their own (a restrictive policy), and the
 * statements here name them anyway.
 */
@Injectable()
export class BulkRepository {
  /**
   * Make a second request with the same key wait for the first to finish.
   *
   * Without this, two retries racing each other would both find no stored answer, both run, and
   * the second would fail on the unique index *after* changing the records twice. The lock is
   * released with the transaction, so the second request then reads the first's stored answer.
   */
  async lockKey(tx: Tx, tenantId: string, userId: string, key: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bulk:${tenantId}:${userId}:${key}`}, 0))`,
    );
  }

  async find(
    tx: Tx,
    tenantId: string,
    userId: string,
    key: string,
  ): Promise<BulkOperationRow | null> {
    const rows = await tx
      .select()
      .from(bulkOperations)
      .where(
        and(
          eq(bulkOperations.tenantId, tenantId),
          eq(bulkOperations.createdBy, userId),
          eq(bulkOperations.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(tx: Tx, values: typeof bulkOperations.$inferInsert): Promise<void> {
    await tx.insert(bulkOperations).values(values);
  }

  /** Forget this person's answers older than the window. Bounded by the (tenant, user, time) index. */
  async sweep(tx: Tx, tenantId: string, userId: string): Promise<void> {
    await tx
      .delete(bulkOperations)
      .where(
        and(
          eq(bulkOperations.tenantId, tenantId),
          eq(bulkOperations.createdBy, userId),
          lt(
            bulkOperations.createdAt,
            sql`now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`,
          ),
        ),
      );
  }
}
