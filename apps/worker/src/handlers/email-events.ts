import {
  EMAIL_BOUNCE_REASONS,
  EMAIL_EVENT_TYPES,
  EMAIL_PAUSE,
  newId,
  shouldPauseEmail,
  statusAfter,
  suppressionFor,
  type EmailBounceReason,
  type EmailEventType,
  type EmailSuppressionReason,
} from '@crm/core';
import {
  auditLogs,
  and,
  emailMessages,
  emailPauses,
  emailSuppressionKey,
  emailSuppressions,
  eq,
  isNull,
  outboxEvents,
  sql,
  type EmailMessageRow,
  type Tx,
} from '@crm/db';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * Applying what the mail service reported about an email (ADR-0075).
 *
 * The public door has already checked the signature, found the company and recorded the event once; this
 * runs inside that company's transaction, under row-level security, with the narrow rights the worker has,
 * and does the four things an event can mean:
 *
 *   1. **the status moves forward**, never back, and never for an email that failed or is still in flight
 *      (`statusAfter`); a repeated event changes nothing;
 *   2. **a permanent bounce or a spam complaint blocks the address**, by hash, whatever the email's own
 *      status is: even one marked "outcome unknown" has told us the address is bad;
 *   3. **a complaint also withdraws the person's consent to email** on the contacts that carry the address
 *      (a lead has no consent record), each with an audit entry;
 *   4. **a bad run pauses the company's email** (`shouldPauseEmail`): too many hard bounces among the last
 *      fifty sent, or complaints in a day. One live pause at a time.
 *
 * A fifth thing is not the mail service's: **the person's own click on the unsubscribe link** (ADR-0076) arrives
 * the same way, as the type `unsubscribed`. It blocks the address and withdraws consent exactly as a complaint
 * does, files one line on the record the email was sent from, and says nothing about whether the mail arrived
 * (the status stays as it was). It is not a bad run, so it never counts toward a pause.
 *
 * Nothing here sends, and nothing written holds the address, the subject or the provider's words: the
 * block list holds a hash, the events hold ids and a closed reason. Delivery of the outbox event is at least
 * once, and every step is idempotent: a second run finds the status already moved, the block already there
 * and the pause already live.
 */

function typeOf(value: unknown): EmailEventType | null {
  return EMAIL_EVENT_TYPES.find((type) => type === value) ?? null;
}

function reasonOf(value: unknown): EmailBounceReason | null {
  return EMAIL_BOUNCE_REASONS.find((reason) => reason === value) ?? null;
}

export function applyEmailProviderEvent(): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const emailId = event.payload['emailId'];
    const type = typeOf(event.payload['eventType']);
    if (typeof emailId !== 'string' || type === null) return;
    const reason = reasonOf(event.payload['reason']);

    const rows = await tx
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.tenantId, event.tenant_id), eq(emailMessages.id, emailId)))
      .limit(1);
    const message = rows[0];
    if (message === undefined) return;

    const next = statusAfter(message.status, type);
    if (next !== null) {
      await tx
        .update(emailMessages)
        .set({
          status: next,
          ...(type === 'bounced' ? { bounceReason: reason ?? 'other' } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(emailMessages.tenantId, event.tenant_id), eq(emailMessages.id, emailId)));
      // On the record it was sent from, so the timeline projection files it there (ADR-0005).
      await tx.insert(outboxEvents).values({
        id: newId(),
        tenantId: event.tenant_id,
        eventType: `email.${type}.v1`,
        objectType: message.sourceObjectType,
        recordId: message.sourceRecordId,
        payload: type === 'bounced' ? { emailId, reason: reason ?? 'other' } : { emailId },
        actorId: null,
      });
    }

    if (type === 'unsubscribed') {
      await tx.insert(outboxEvents).values({
        id: newId(),
        tenantId: event.tenant_id,
        eventType: 'email.unsubscribed.v1',
        objectType: message.sourceObjectType,
        recordId: message.sourceRecordId,
        payload: { emailId },
        actorId: null,
      });
    }

    const blockedFor = suppressionFor(type);
    if (blockedFor === null) return;
    await blockAddress(tx, event, message, blockedFor);
    // Only the mail service's own bad news is a bad run: a person who chose to stop is not one.
    if (type !== 'unsubscribed') await pauseIfBadRun(tx, event);
  };
}

async function blockAddress(
  tx: Tx,
  event: OutboxRow,
  message: EmailMessageRow,
  reason: EmailSuppressionReason,
): Promise<void> {
  // An erasure may have scrubbed the address already: then there is nothing left to block by.
  if (message.toAddress === null) return;

  const created = await tx
    .insert(emailSuppressions)
    .values({
      id: newId(),
      tenantId: event.tenant_id,
      addressHash: emailSuppressionKey(event.tenant_id, message.toAddress),
      reason,
      sourceEmailId: message.id,
    })
    // One live block per address: a second report for the same address adds nothing.
    .onConflictDoNothing()
    .returning({ id: emailSuppressions.id });
  // Every block added is in the audit log, with the email that caused it and never the address (ADR-0076).
  const block = created[0];
  if (block !== undefined) {
    await tx.insert(auditLogs).values({
      id: newId(),
      tenantId: event.tenant_id,
      actorId: null,
      action: 'create',
      objectType: 'email_suppression',
      recordId: block.id,
      changes: { reason: { new: reason }, source: { new: `email:${message.id}` } },
    });
  }

  // A bounce says the address does not work, not that the person refused: only a refusal withdraws consent.
  if (reason === 'hard_bounce') return;

  // The person has said they do not want this email, which is the withdrawal of consent the send path
  // already respects (`contacts.consent`). Each contact that carries the address gets it, and an audit entry.
  // A contact that has already withdrawn is left as it is: the first refusal is the one on record.
  const source = reason === 'unsubscribed' ? 'unsubscribe_link' : 'spam_complaint';
  const note =
    reason === 'unsubscribed'
      ? 'email withdrawn: unsubscribed from the link in an email'
      : 'email withdrawn: reported as spam';
  const changed = await tx.execute(sql`
    update contacts
    set consent = jsonb_set(
          coalesce(consent, '{}'::jsonb),
          '{email}',
          jsonb_build_object('status', 'withdrawn', 'source', ${source}::text, 'at', now()),
          true),
        updated_at = now()
    where tenant_id = ${event.tenant_id}::uuid
      and email = ${message.toAddress}
      and deleted_at is null
      and coalesce(consent #>> '{email,status}', '') <> 'withdrawn'
    returning id
  `);
  for (const row of changed.rows as unknown as { id: string }[]) {
    await tx.insert(auditLogs).values({
      id: newId(),
      tenantId: event.tenant_id,
      actorId: null,
      action: 'update',
      objectType: 'contact',
      recordId: row.id,
      changes: { consent: { new: note } },
    });
  }
}

async function pauseIfBadRun(tx: Tx, event: OutboxRow): Promise<void> {
  const counts = await tx.execute(sql`
    select
      (select count(*)::int from (
         select status from email_messages
         where tenant_id = ${event.tenant_id}::uuid
           and status in ('sent', 'delivered', 'bounced', 'complained')
         order by sent_at desc nulls last, id desc
         limit ${EMAIL_PAUSE.windowSent}
       ) recent where status = 'bounced') as bounces,
      (select count(*)::int from email_provider_events
        where tenant_id = ${event.tenant_id}::uuid
          and event_type = 'complained'
          and created_at > now() - interval '24 hours') as complaints
  `);
  const row = counts.rows[0] as unknown as { bounces: number; complaints: number } | undefined;
  const hardBouncesInWindow = row?.bounces ?? 0;
  const complaintsToday = row?.complaints ?? 0;
  if (!shouldPauseEmail({ hardBouncesInWindow, complaintsToday })) return;

  const live = await tx
    .select({ id: emailPauses.id })
    .from(emailPauses)
    .where(and(eq(emailPauses.tenantId, event.tenant_id), isNull(emailPauses.resumedAt)))
    .limit(1);
  if (live.length > 0) return;

  const id = newId();
  const reason = complaintsToday >= EMAIL_PAUSE.complaintsPerDay ? 'complaints' : 'bounces';
  const inserted = await tx
    .insert(emailPauses)
    .values({ id, tenantId: event.tenant_id, reason, pausedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: emailPauses.id });
  if (inserted.length === 0) return;

  await tx.insert(auditLogs).values({
    id: newId(),
    tenantId: event.tenant_id,
    actorId: null,
    action: 'create',
    objectType: 'email_pause',
    recordId: id,
    changes: { paused: { new: true }, reason: { new: reason } },
  });
  await tx.insert(outboxEvents).values({
    id: newId(),
    tenantId: event.tenant_id,
    eventType: 'email_pause.created.v1',
    objectType: 'email_pause',
    recordId: id,
    payload: { reason },
    actorId: null,
  });
}
