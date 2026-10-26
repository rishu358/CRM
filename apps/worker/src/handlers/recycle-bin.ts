import {
  newId,
  PURGE_BATCH_SIZE,
  PURGE_SWEEP_INTERVAL_HOURS,
  RECYCLE_BIN_RETENTION_DAYS,
} from '@crm/core';
import {
  allRecyclableDescriptors,
  auditLogs,
  hardDelete,
  outboxEvents,
  POLYMORPHIC_REFERENCE_TABLE_LIST,
  removeReferences,
  selectPurgeable,
  sql,
  type Tx,
} from '@crm/db';
import type { EventHandler, ExhaustedHandler, OutboxRow } from '../relay.js';

/** Re-exported: the list lives in `@crm/db` now, beside the function that uses it. */
export { POLYMORPHIC_REFERENCE_TABLE_LIST };

/**
 * The Recycle Bin's purge job (MVP_SPEC M4).
 *
 * "Soft delete → Recycle Bin (restore within 30 days, then hard delete by job)."
 * This is that job, and three things about it are deliberate.
 *
 * **It schedules itself.** There is no cron and no cross-tenant sweep. A sweep
 * is an outbox row dated to when it is next due, and this handler arms the next
 * one in the same transaction as the work — the pattern ADR-0025 established
 * for reminders and digests. A partial unique index
 * (`outbox_events_one_pending_sweep`) keeps that at exactly one pending row per
 * tenant, so a redelivery, a concurrent soft delete and the migration's backfill
 * cannot between them queue two.
 *
 * The alternative — one event per deleted record, dated to `deleted_at + 30
 * days` — was simpler and is wrong at scale: a bulk delete of 50,000 contacts
 * would leave 50,000 rows in the relay's pending index for a month.
 *
 * **It is idempotent**, as at-least-once delivery requires (ADR-0006). Rows are
 * claimed with `FOR UPDATE SKIP LOCKED` and deleted with the `deleted_at is not
 * null` guard repeated, so a second run finds nothing to do rather than doing it
 * twice — and a record somebody is restoring right now is skipped instead of
 * being deleted out from under them.
 *
 * **It cleans up what soft delete left behind.** A soft delete removes the
 * record from search and from the lists, but the rows that *point* at it —
 * polymorphic links, tags, timeline entries, recently-viewed — are deliberately
 * kept, because a restored contact should still have its tasks and its history
 * attached (see `pruneActivityLinks`). Purging is the moment they stop being
 * worth keeping, and this handler removes them **in the same transaction** as
 * the record. They are not side effects to be announced: they are rows in the
 * same database that would otherwise reference a row that no longer exists, and
 * a crash between the two would leave exactly that.
 *
 * It also publishes `<object>.purged.v1` for anything that lives outside this
 * database and cannot be cleaned up transactionally — a stored attachment's
 * bytes being the case that is coming. Such a handler subscribes to that event;
 * it does not get added to the table list below.
 */

export interface PurgeDeps {
  readonly batchSize?: number;
  readonly retentionDays?: number;
}

export function runPurgeSweep(deps: PurgeDeps = {}): EventHandler {
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  const retentionDays = deps.retentionDays ?? RECYCLE_BIN_RETENTION_DAYS;

  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    // The cutoff is computed by the **database's** clock, like every other
    // deadline in this system: the relay compares `available_at` against
    // `now()`, and a retention window judged by this process's clock would drift
    // by however far the two disagree.
    // Rendered to text and cast back in SQL, so the comparison uses exactly the
    // instant Postgres computed rather than a millisecond-truncated copy.
    const cutoff = (
      await tx.execute(
        sql`select (now() - make_interval(days => ${retentionDays}))::text as cutoff`,
      )
    ).rows[0] as unknown as { cutoff: string };

    let purgedTotal = 0;

    for (const descriptor of allRecyclableDescriptors()) {
      const ids = await selectPurgeable(tx, event.tenant_id, descriptor, cutoff.cutoff, batchSize);
      if (ids.length === 0) continue;

      await removeReferences(tx, event.tenant_id, descriptor.objectType, ids);
      const removed = await hardDelete(tx, event.tenant_id, descriptor, ids);
      purgedTotal += removed;

      // One audit row per purged record. A deletion nobody can undo is exactly
      // the kind of thing CLAUDE.md §5.10 means, and `actor_id` is null because
      // the system did it — which is itself the fact worth recording.
      if (removed > 0) {
        await tx.insert(auditLogs).values(
          ids.map((id) => ({
            id: newId(),
            tenantId: event.tenant_id,
            actorId: null,
            action: 'purge',
            objectType: descriptor.objectType,
            recordId: id,
            changes: { retentionDays: { new: retentionDays } },
          })),
        );

        await tx.insert(outboxEvents).values(
          ids.map((id) => ({
            id: newId(),
            tenantId: event.tenant_id,
            eventType: `${descriptor.objectType}.purged.v1`,
            objectType: descriptor.objectType,
            recordId: id,
          })),
        );
      }
    }

    // Arm the next sweep. If this batch filled up there is more to do, so come
    // back promptly rather than tomorrow — a tenant that deleted a hundred
    // thousand records should not take a hundred thousand days to be rid of
    // them.
    const more = purgedTotal >= batchSize;
    await armSweep(
      tx,
      event.tenant_id,
      more ? { minutes: 1 } : { hours: PURGE_SWEEP_INTERVAL_HOURS },
    );
  };
}

/**
 * Put the next sweep in the queue.
 *
 * `onConflictDoNothing` against the partial unique index, so this is safe to
 * call from a redelivery, from a soft delete, and from provisioning. Note the
 * index covers `status = 'pending'` only, which is what lets the sweep that is
 * currently *processing* arm its own successor.
 */
export async function armSweep(
  tx: Tx,
  tenantId: string,
  delay: { readonly minutes: number } | { readonly hours: number },
): Promise<void> {
  const availableAt =
    'minutes' in delay
      ? sql`now() + make_interval(mins => ${delay.minutes})`
      : sql`now() + make_interval(hours => ${delay.hours})`;

  await tx
    .insert(outboxEvents)
    .values({
      id: newId(),
      tenantId,
      eventType: 'recycle_bin.sweep_due.v1',
      objectType: 'tenant',
      recordId: tenantId,
      availableAt,
    })
    .onConflictDoNothing();
}

/**
 * The relay has given up on a sweep.
 *
 * Without this the chain stops: the failed row is no longer `pending`, so
 * nothing is scheduled and that tenant's Bin never empties again. Re-armed from
 * a fresh transaction for the reason `ExhaustedHandler` explains, and dated an
 * hour out rather than immediately so a persistent fault does not spin.
 */
export function rearmSweepOnExhaustion(deps: { withTenant: WithTenant }): ExhaustedHandler {
  return async (event) => {
    await deps.withTenant(event.tenant_id, (tx) => armSweep(tx, event.tenant_id, { hours: 1 }));
  };
}

export type WithTenant = (tenantId: string, work: (tx: Tx) => Promise<void>) => Promise<void>;
