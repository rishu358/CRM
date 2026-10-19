import { newId } from '@crm/core';
import { outboxEvents, type Tx } from '@crm/db';

/**
 * Write a domain event from inside the worker (ADR-0006).
 *
 * The same row the API's `OutboxService` writes, in the transaction the caller
 * already holds, so the event exists if and only if the work did.
 *
 * `priority` backdates `available_at` by an hour. The relay claims events
 * ordered by `available_at`, and a chunk of 500 records writes 500 events with
 * a timestamp of *now* — so the next chunk's event, written in the same
 * transaction, would queue **behind** all 500 of them and the import would
 * advance one chunk per 500 side effects. Backdating puts the next chunk first,
 * which is what keeps a 50,000-row import moving at the speed of the import
 * and not the speed of search indexing. The side effects still all happen;
 * they just do not set the pace.
 */
export async function publishEvent(
  tx: Tx,
  event: {
    readonly tenantId: string;
    readonly actorId: string | null;
    readonly eventType: string;
    readonly objectType: string;
    readonly recordId: string;
    readonly payload?: Record<string, unknown>;
    readonly priority?: boolean;
  },
): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: newId(),
    tenantId: event.tenantId,
    eventType: event.eventType,
    objectType: event.objectType,
    recordId: event.recordId,
    payload: event.payload ?? {},
    actorId: event.actorId,
    ...(event.priority === true ? { availableAt: new Date(Date.now() - 3_600_000) } : {}),
  });
}
