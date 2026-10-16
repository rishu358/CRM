import { newId } from '@crm/core';
import { timelineEvents, type Tx, sql } from '@crm/db';
import type { OutboxRow } from '../relay.js';

/**
 * Projects domain events into the per-record timeline (ADR-0005, ADR-0006).
 *
 * The timeline is denormalised so a record page renders its history with one
 * indexed read instead of a union across every table that might mention the
 * record.
 *
 * **Idempotent by construction.** Delivery is at-least-once, so this handler
 * will sometimes run twice for the same event. `timeline_events.source_event_id`
 * is unique per tenant, and the insert does nothing on conflict — so a retry
 * cannot produce a duplicate entry in a customer's history.
 */
const SUMMARIES: Readonly<Record<string, string>> = {
  'contact.created.v1': 'Contact created',
  'contact.updated.v1': 'Contact updated',
  'contact.deleted.v1': 'Contact deleted',
};

export async function projectTimeline(tx: Tx, event: OutboxRow): Promise<void> {
  const summary = SUMMARIES[event.event_type];
  if (summary === undefined || event.object_type === null || event.record_id === null) {
    return;
  }

  await tx
    .insert(timelineEvents)
    .values({
      id: newId(),
      tenantId: event.tenant_id,
      objectType: event.object_type,
      recordId: event.record_id,
      eventType: event.event_type,
      summary: describeChange(event, summary),
      detail: event.payload,
      actorId: event.actor_id,
      sourceEventId: event.id,
      createdBy: event.actor_id,
      updatedBy: event.actor_id,
    })
    .onConflictDoNothing({
      target: [timelineEvents.tenantId, timelineEvents.sourceEventId],
    });
}

/** "Contact updated" is less useful than naming what changed. */
function describeChange(event: OutboxRow, fallback: string): string {
  const changed = event.payload['changedFields'];
  if (Array.isArray(changed) && changed.length > 0) {
    const names = changed.filter((value): value is string => typeof value === 'string');
    if (names.length > 0) return `${fallback}: ${names.join(', ')}`;
  }
  return fallback;
}

/** Remove timeline entries for a record that was hard-deleted. */
export async function pruneTimelineFor(
  tx: Tx,
  tenantId: string,
  objectType: string,
  recordId: string,
): Promise<void> {
  await tx.execute(
    sql`delete from timeline_events
        where tenant_id = ${tenantId}
          and object_type = ${objectType}
          and record_id = ${recordId}`,
  );
}
