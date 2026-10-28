import { newId } from '@crm/core';
import { timelineEvents, type Tx, sql } from '@crm/db';
import { isHistoricalEvent, type OutboxRow } from '../relay.js';

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
  'deal.created.v1': 'Deal created',
  'deal.updated.v1': 'Deal updated',
  'deal.deleted.v1': 'Deal deleted',
  // Worded per event by `describeChange`: "Moved from Qualified to Proposal".
  'deal.stage_changed.v1': 'Deal moved',
  'lead.created.v1': 'Lead created',
  'lead.updated.v1': 'Lead updated',
  'lead.deleted.v1': 'Lead deleted',
  'lead.converted.v1': 'Lead converted',
  // A contact or account that conversion only *linked* gets no `created`
  // event of its own, so without these its history would never mention the
  // lead it now carries (ADR-0022).
  'contact.linked_from_lead.v1': 'Lead converted onto this contact',
  'account.linked_from_lead.v1': 'Lead converted onto this account',
  // Activities are projected onto the record they are *about*, not onto the
  // activity: one event per link, carrying the target's object type and id,
  // so a meeting about a contact and a deal appears on both timelines
  // (ADR-0005). Worded per event by `describeChange`.
  'activity.linked.v1': 'Activity added',
  'activity.completed.v1': 'Activity completed',
  // Restored from the Recycle Bin (MVP_SPEC M4). The timeline rows survive a
  // soft delete deliberately, so the history a restored record comes back with
  // now ends with the fact that it came back.
  'account.restored.v1': 'Account restored',
  'contact.restored.v1': 'Contact restored',
  'lead.restored.v1': 'Lead restored',
  'deal.restored.v1': 'Deal restored',
  'activity.restored.v1': 'Activity restored',
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

/**
 * What the timeline says, and for imported history that it came from a file: a record whose creation
 * date was set by an import was not "created" on the day the row appears in its timeline.
 */
function describeChange(event: OutboxRow, fallback: string): string {
  const text = describeEvent(event, fallback);
  if (!isHistoricalEvent(event)) return text;
  return event.event_type.endsWith('.created.v1')
    ? text.replace(/ created$/, ' imported')
    : `${text} (by an import)`;
}

/** "Contact updated" is less useful than naming what changed. */
function describeEvent(event: OutboxRow, fallback: string): string {
  if (event.event_type === 'deal.stage_changed.v1') {
    const from = event.payload['fromStageName'];
    const to = event.payload['toStageName'];
    if (typeof to === 'string' && to.length > 0) {
      return typeof from === 'string' && from.length > 0
        ? `Moved from ${from} to ${to}`
        : `Moved to ${to}`;
    }
  }

  if (event.event_type === 'lead.converted.v1') {
    const created = [
      event.payload['contactCreated'] === true ? 'contact' : null,
      event.payload['accountCreated'] === true ? 'account' : null,
      typeof event.payload['dealId'] === 'string' ? 'deal' : null,
    ].filter((part): part is string => part !== null);
    const linked =
      event.payload['contactCreated'] === false ? ' and linked to an existing contact' : '';
    return created.length > 0
      ? `Converted: created ${created.join(', ')}${linked}`
      : `Converted${linked}`;
  }

  if (event.event_type === 'activity.linked.v1' || event.event_type === 'activity.completed.v1') {
    const subject = event.payload['subject'];
    const kind = event.payload['activityType'];
    const noun = typeof kind === 'string' && kind.length > 0 ? titleCase(kind) : 'Activity';
    const verb = event.event_type === 'activity.completed.v1' ? 'completed' : 'added';
    return typeof subject === 'string' && subject.length > 0
      ? `${noun} ${verb}: ${subject}`
      : `${noun} ${verb}`;
  }

  const changed = event.payload['changedFields'];
  if (Array.isArray(changed) && changed.length > 0) {
    const names = changed.filter((value): value is string => typeof value === 'string');
    if (names.length > 0) return `${fallback}: ${names.join(', ')}`;
  }
  return fallback;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
