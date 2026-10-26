import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IDEMPOTENCY_WINDOW_HOURS,
  IdempotentRecordUnavailableError,
  newId,
  NotFoundError,
  type Actor,
} from '@crm/core';
import { markIdempotentReplay } from '../common/request-context.js';
import { bulkOperations, type BulkOperationRow, type Tx, and, eq, lt, sql } from '@crm/db';

/** What a remembered answer is filed under, so a key reused for something else is noticed. */
export interface IdempotentOperation {
  readonly objectType: string;
  readonly action: string;
}

/** What is remembered about a request that worked: the id of its record, and ids and names only. */
export interface IdempotentReference {
  readonly recordId: string;
  readonly [more: string]: unknown;
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
 *   2. look for a reference stored under that key. Found, and for the same request: re-read the record
 *      it names and return that, doing nothing else. Found, for a different request: refuse with 409,
 *      never answer with the wrong record;
 *   3. otherwise do the work, and store a reference to what it created in the same transaction.
 *
 * Because the reference is stored in the transaction that created the record, the two exist together
 * or not at all: there is no window in which the record is there and the key is not (a crash there
 * would make the retry a duplicate), and a failed request leaves nothing behind, so the retry can
 * succeed. The lock is released with the transaction, so the waiting request then replays.
 *
 * ## What is stored: a reference, never the record
 *
 * Only the id of what was created (and, for a lead conversion, the ids of what it made or linked and
 * which fields it skipped). A replay **re-reads the record through the same read path and serializer
 * as `GET`**, as the same person, so it shows the record as it is now, honours field permissions as
 * they are now, and there is no copy of anybody's data in this table to find, expire or erase. If the
 * record has been deleted since, or the person can no longer read it, the replay says so with
 * `IDEMPOTENT_RECORD_UNAVAILABLE` (409), not a 404 that would look as though the first request never
 * created anything.
 *
 * ## Whose key
 *
 * A key belongs to one person in one workspace: the same text from somebody else, or in another
 * workspace, is a different key. Row-level security gives the workspace; the table's restrictive
 * policy gives the person (migration 0023); and every statement here names both anyway.
 *
 * The table is called `bulk_operations` because that is what first used it; a rename is a migration
 * with nothing to gain but a name. A person's older keys are deleted whenever they next use one, and
 * the worker's daily sweep deletes the rest after `IDEMPOTENCY_WINDOW_HOURS`.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Do `work` once per (person, key). Without a key this is `work().value`: idempotency is opt-in.
   *
   * `request` is whatever identifies the request (its body, and the id when the route has one); two
   * requests are "the same" when it has the same content, whatever the order of its keys.
   * `work` returns the answer and a `reference` to remember, which must hold ids and nothing else;
   * `replay` turns that reference back into an answer by re-reading.
   */
  async once<T>(
    tx: Tx,
    actor: Actor,
    key: string | undefined,
    operation: IdempotentOperation,
    request: unknown,
    work: () => Promise<{ readonly answer: T; readonly reference: IdempotentReference }>,
    replay: (reference: IdempotentReference) => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return (await work()).answer;

    const requestHash = hashRequest({ ...operation, request });
    await this.lockKey(tx, actor.tenantId, actor.userId, key);
    const stored = await this.find(tx, actor.tenantId, actor.userId, key);
    if (stored !== null) {
      if (stored.requestHash !== requestHash) throw reusedKey();
      markIdempotentReplay();
      try {
        return await replay(stored.result as unknown as IdempotentReference);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError) {
          throw new IdempotentRecordUnavailableError();
        }
        throw error;
      }
    }

    const { answer, reference } = await work();

    await this.sweep(tx, actor.tenantId, actor.userId);
    await this.insert(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      idempotencyKey: key,
      objectType: operation.objectType,
      action: operation.action,
      requestHash,
      result: reference,
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
    // The wait is bounded, so a request that is stuck cannot hold the next one, and its connection,
    // for ever: after `LOCK_WAIT_SECONDS` the caller is told to come back, and the retry is a replay.
    // The timeout covers this statement only; whatever was set before is put back afterwards.
    const previous = (await tx.execute(sql`select current_setting('lock_timeout') as value`))
      .rows[0] as { value: string };
    await tx.execute(sql`select set_config('lock_timeout', ${`${LOCK_WAIT_SECONDS}s`}, true)`);
    try {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bulk:${tenantId}:${userId}:${key}`}, 0))`,
      );
    } catch (error) {
      if (isLockTimeout(error)) throw new IdempotencyInProgressError(LOCK_WAIT_SECONDS);
      throw error;
    }
    await tx.execute(sql`select set_config('lock_timeout', ${previous.value}, true)`);
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
export function reusedKey(): IdempotencyKeyReusedError {
  return new IdempotencyKeyReusedError();
}

/** How long a second request with the same key waits for the first, in whole seconds. */
const LOCK_WAIT_SECONDS = 3;

/** Postgres `lock_not_available` (SQLSTATE 55P03), through whatever wrapped it. */
function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object' && (current as { code?: unknown }).code === '55P03')
      return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
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
