import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, IDEMPOTENCY_WINDOW_HOURS, newId, type Actor } from '@crm/core';
import { bulkOperations, type BulkOperationRow, type Tx, and, eq, lt, sql } from '@crm/db';

/** What a remembered answer is filed under, so a key reused for something else is noticed. */
export interface IdempotentOperation {
  readonly objectType: string;
  readonly action: string;
}

/**
 * `Idempotency-Key` for everything that creates a record (CLAUDE.md §6).
 *
 * A caller that retries a save after a dropped connection must get the first answer, not a second
 * record. The first user of this was the bulk actions (ADR-0056); every create route now shares it
 * (pilot finding F6, ADR-0060), so the rule is written once.
 *
 * ## How
 *
 * `once` runs *inside the transaction the work already uses*:
 *
 *   1. take a lock named by (workspace, person, key), so a second request with the same key waits for
 *      the first to finish instead of running beside it;
 *   2. look for an answer stored under that key. Found, and for the same request: return it, and do
 *      nothing else. Found, for a different request: refuse with 409, never answer with the wrong record;
 *   3. otherwise do the work, and store its answer in the same transaction.
 *
 * Because the answer is stored in the transaction that created the record, the two exist together or
 * not at all: there is no window in which the record is there and the key is not (a crash there would
 * make the retry a duplicate), and a failed request leaves nothing behind, so the retry can succeed.
 * The lock is released with the transaction, so the waiting request then reads the stored answer.
 *
 * ## Whose key
 *
 * A key belongs to one person in one workspace: the same text from somebody else, or in another
 * workspace, is a different key. Row-level security gives the workspace; the table's restrictive
 * policy gives the person (migration 0023); and every statement here names both anyway.
 *
 * ## What is stored
 *
 * The answer, as the service returned it, which is what the person was shown: field permissions were
 * applied when it was built. It is kept for `IDEMPOTENCY_WINDOW_HOURS`: a person's older answers are
 * deleted whenever they next use a key, and the worker's retention sweep deletes the rest.
 *
 * The table is called `bulk_operations` because that is what first used it; a rename is a migration
 * with nothing to gain but a name.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Do `work` once per (person, key). Without a key this is `work()`: idempotency is opt-in.
   *
   * `request` is whatever identifies the request (its body, and the id when the route has one); two
   * requests are "the same" when it has the same content, whatever the order of its keys.
   */
  async once<T>(
    tx: Tx,
    actor: Actor,
    key: string | undefined,
    operation: IdempotentOperation,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return work();

    const requestHash = hashRequest({ ...operation, request });
    await this.lockKey(tx, actor.tenantId, actor.userId, key);
    const stored = await this.find(tx, actor.tenantId, actor.userId, key);
    if (stored !== null) {
      if (stored.requestHash !== requestHash) throw reusedKey();
      return stored.result as T;
    }

    const answer = await work();

    await this.sweep(tx, actor.tenantId, actor.userId);
    await this.insert(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      idempotencyKey: key,
      objectType: operation.objectType,
      action: operation.action,
      requestHash,
      // Through JSON, so what is replayed is exactly what was stored, whatever the in-memory shape.
      result: JSON.parse(JSON.stringify(answer)) as Record<string, unknown>,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    return answer;
  }

  /**
   * Make a second request with the same key wait for the first to finish.
   *
   * Without this, two retries racing each other would both find no stored answer, both run, and the
   * second would fail on the unique index *after* creating the record twice.
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

/** The one answer for a key used for a different request than the one it first named. */
export function reusedKey(): ConflictError {
  return new ConflictError('This Idempotency-Key was already used for a different request');
}

/** A stable fingerprint of a request: key order, and absent values, do not change it. */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
