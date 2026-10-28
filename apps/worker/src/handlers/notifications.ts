import { newId, type EmailProvider } from '@crm/core';
import { escapeHtml } from '@crm/core/html';
import { notifications, outboxEvents, type Tx, sql } from '@crm/db';
import type { OutboxRow } from '../relay.js';

/**
 * Notifications and the email digest (MVP_SPEC M6, ADR-0025).
 *
 * Everything here is driven by outbox events, never called inline by a
 * service (ADR-0006): a notification that fired for a transaction which then
 * rolled back is worse than a late one, because the person acts on it.
 *
 * **Idempotency.** Delivery is at-least-once, so each handler must be able to
 * run twice for the same event. Notifications carry `source_event_id`, unique
 * per tenant, and insert with `ON CONFLICT DO NOTHING` — a redelivery writes
 * nothing rather than ringing the bell twice.
 *
 * **Scheduling.** There is no timer, no cron and no cross-tenant sweep. A
 * reminder is an outbox row dated to when it is due, and a digest is an
 * outbox row dated a window into the future; the relay's existing
 * `available_at <= now()` claim is what holds both back (ADR-0025).
 */

/** How long after the first notification the digest email goes out. */
export const DEFAULT_DIGEST_WINDOW_MINUTES = 15;

export interface NotificationHandlerOptions {
  readonly email: EmailProvider;
  readonly emailFrom: string;
  readonly webUrl: string;
  /** What the installation calls itself in the digest (`APP_NAME`). */
  readonly appName: string;
  readonly digestWindowMinutes: number;
}

interface NotificationInsert {
  readonly tenantId: string;
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sourceEventId: string;
}

/**
 * Write one notification, at most once per source event.
 *
 * Returns whether a row was actually written, so the caller only schedules a
 * digest for news that is genuinely new.
 */
async function insertNotification(tx: Tx, input: NotificationInsert): Promise<boolean> {
  const rows = await tx
    .insert(notifications)
    .values({
      id: newId(),
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      sourceEventId: input.sourceEventId,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  return rows.length > 0;
}

/**
 * Open a digest window for this person.
 *
 * One row per notification rather than bookkeeping to keep exactly one
 * pending: the first digest to fire sends everything that has accumulated
 * and marks it digested, so the ones behind it find nothing to send and do
 * nothing. Cheap rows, no shared state, and no way to end up with a window
 * that never closes.
 */
async function scheduleDigest(
  tx: Tx,
  event: OutboxRow,
  userId: string,
  windowMinutes: number,
): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: newId(),
    tenantId: event.tenant_id,
    eventType: 'notification.digest_due.v1',
    objectType: 'user',
    recordId: userId,
    payload: { userId },
    // Dated by the **database's** clock, because that is the clock the relay
    // compares against (`available_at <= now()`). Computing it from this
    // process's clock would make the window drift by however far the two
    // disagree — which is never zero across a pool of app servers, and on a
    // laptop that has slept is seconds.
    availableAt: sql`now() + make_interval(mins => ${windowMinutes})`,
    actorId: event.actor_id,
  });
}

/** Somebody gave this person a task, call or meeting. */
export function notifyAssignment(options: NotificationHandlerOptions) {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const assignedTo = event.payload['assignedTo'];
    if (typeof assignedTo !== 'string' || event.record_id === null) return;

    const written = await insertNotification(tx, {
      tenantId: event.tenant_id,
      userId: assignedTo,
      type: 'activity.assigned',
      payload: {
        activityId: event.record_id,
        subject: event.payload['subject'] ?? null,
        activityType: event.payload['type'] ?? null,
        dueAt: event.payload['dueAt'] ?? null,
      },
      sourceEventId: event.id,
    });

    if (written) await scheduleDigest(tx, event, assignedTo, options.digestWindowMinutes);
  };
}

/**
 * A task is due.
 *
 * The event was scheduled when the activity was written, so by the time it
 * arrives the activity may have been completed, reassigned, rescheduled or
 * deleted. Cancelling a pending outbox row would mean the service reaching
 * into the relay's table to find it; re-reading the activity here is simpler
 * and strictly safer, because it also covers the row somebody edited by hand
 * or through an import. The reminder instant travels in the payload exactly
 * so this check can be made (ADR-0025).
 */
export function notifyReminder() {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;

    const result = await tx.execute(sql`
      select assigned_to, subject, status, reminder_at, deleted_at
      from activities
      where id = ${event.record_id}
      limit 1
    `);
    // `tx.execute` returns driver rows, not Drizzle-mapped ones, so a
    // timestamptz arrives as whatever pg parsed it into — a string here.
    // Everything below therefore goes through `new Date(...)` rather than
    // assuming a Date, which is the kind of mistake that only shows up at
    // runtime months later.
    const row = (
      result.rows as unknown as {
        assigned_to: string | null;
        subject: string;
        status: string;
        reminder_at: string | Date | null;
        deleted_at: string | Date | null;
      }[]
    )[0];

    if (row === undefined || row.deleted_at !== null) return;
    if (row.status !== 'open' || row.assigned_to === null) return;

    // Rescheduled since: a later event carries the new time, and this one is
    // about a moment that no longer means anything.
    const scheduledFor = event.payload['reminderAt'];
    if (typeof scheduledFor !== 'string' || row.reminder_at === null) return;

    const stillScheduledFor = new Date(row.reminder_at).getTime();
    if (stillScheduledFor !== new Date(scheduledFor).getTime()) return;

    await insertNotification(tx, {
      tenantId: event.tenant_id,
      userId: row.assigned_to,
      type: 'activity.due',
      payload: { activityId: event.record_id, subject: row.subject, dueAt: scheduledFor },
      sourceEventId: event.id,
    });

    // No digest is scheduled for a reminder: the point of a reminder is that
    // it is timely, and an email fifteen minutes later about something that
    // was due fifteen minutes ago is not news. The bell has it immediately,
    // and the next assignment's digest will carry it if it is still unread.
  };
}

/**
 * Send one person their digest, then mark what it covered.
 *
 * `digested_at` rather than `read_at`: a digest must not re-send what it has
 * already sent, but it must also not pretend the person has seen it — the
 * bell keeps showing it as unread until they actually look.
 */
export function sendDigest(options: NotificationHandlerOptions) {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const userId = event.payload['userId'];
    if (typeof userId !== 'string') return;

    const pending = await tx.execute(sql`
      select id, type, payload
      from notifications
      where tenant_id = ${event.tenant_id}
        and user_id = ${userId}
        and digested_at is null
        and read_at is null
      order by created_at
      limit 50
    `);
    const rows = pending.rows as unknown as {
      id: string;
      type: string;
      payload: Record<string, unknown>;
    }[];
    if (rows.length === 0) return;

    const recipient = await tx.execute(sql`
      select email::text as email, name from users where id = ${userId} limit 1
    `);
    const user = (recipient.rows as unknown as { email: string; name: string }[])[0];
    if (user === undefined) return;

    // Marked before sending, inside this transaction. If the send then
    // fails, the relay retries the whole event and the second attempt finds
    // nothing pending — so a flaky mail provider costs one lost digest
    // rather than an infinite loop of duplicates to a real person's inbox.
    await tx.execute(sql`
      update notifications set digested_at = now()
      where tenant_id = ${event.tenant_id}
        and id in (${sql.join(
          rows.map((row) => sql`${row.id}`),
          sql`, `,
        )})
    `);

    await options.email.send(renderDigest(user, rows, options.webUrl, options.appName));
  };
}

/**
 * The digest message.
 *
 * Every value that comes out of the database is escaped before it goes into
 * the HTML part — a task subject is something a user typed, and an email
 * client renders HTML (ADR-0024). The text part carries the same lines
 * unescaped, which is correct there and nowhere else.
 */
function renderDigest(
  user: { email: string; name: string },
  rows: readonly { type: string; payload: Record<string, unknown> }[],
  webUrl: string,
  appName: string,
): { to: string; subject: string; text: string; html: string } {
  const lines = rows.map((row) => {
    // Web-form notifications say what happened and carry nothing a visitor typed.
    if (row.type === 'lead.web_form_new') return 'A new lead from a web form is assigned to you';
    if (row.type === 'lead.web_form_duplicate') {
      return 'A web form was filled in by someone who matches a record you own';
    }
    const subject = typeof row.payload['subject'] === 'string' ? row.payload['subject'] : 'A task';
    return row.type === 'activity.due' ? `Due: ${subject}` : `Assigned to you: ${subject}`;
  });

  const heading = rows.length === 1 ? '1 update' : `${rows.length} updates`;
  const link = `${webUrl}/my-day`;

  const text = [
    `Hello ${user.name},`,
    '',
    `You have ${heading} waiting in your ${appName}:`,
    '',
    ...lines.map((line) => `  • ${line}`),
    '',
    `Open My Day: ${link}`,
  ].join('\n');

  const html = [
    `<p>Hello ${escapeHtml(user.name)},</p>`,
    `<p>You have ${escapeHtml(heading)} waiting in your ${escapeHtml(appName)}:</p>`,
    '<ul>',
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    '</ul>',
    `<p><a href="${escapeHtml(link)}">Open My Day</a></p>`,
  ].join('\n');

  return { to: user.email, subject: `Your ${appName}: ${heading}`, text, html };
}

/**
 * A website form made a lead and it was given to somebody (ADR-0065 8).
 *
 * Driven by `lead.created.v1`, which every lead announces; only the ones a form made (`source` is
 * `web_form`) and that have an owner are of interest here. The notification carries **ids only**:
 * what the visitor typed is never copied into a notification row or a digest, so a stranger's words
 * cannot reach the bell or an e-mail by this route (and the lead itself is read through the lead
 * endpoint, with the reader's own permissions).
 */
export function notifyWebFormLead(options: NotificationHandlerOptions) {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.payload['source'] !== 'web_form' || event.record_id === null) return;
    const ownerId = event.payload['ownerId'];
    if (typeof ownerId !== 'string') return;

    const written = await insertNotification(tx, {
      tenantId: event.tenant_id,
      userId: ownerId,
      type: 'lead.web_form_new',
      payload: { leadId: event.record_id, formId: event.payload['formId'] ?? null },
      sourceEventId: event.id,
    });
    if (written) await scheduleDigest(tx, event, ownerId, options.digestWindowMinutes);
  };
}

/**
 * A website form was filled in by somebody who matches a record that already exists (ADR-0065 7).
 * The owner of what it matched is told; the visitor never is. Ids only, like the one above.
 */
export function notifyWebFormDuplicate(options: NotificationHandlerOptions) {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const owner = event.payload['matchedOwnerId'];
    if (typeof owner !== 'string' || event.record_id === null) return;

    const written = await insertNotification(tx, {
      tenantId: event.tenant_id,
      userId: owner,
      type: 'lead.web_form_duplicate',
      payload: {
        leadId: event.record_id,
        matchedType: event.payload['matchedType'] ?? null,
        matchedId: event.payload['matchedId'] ?? null,
        formId: event.payload['formId'] ?? null,
      },
      sourceEventId: event.id,
    });
    if (written) await scheduleDigest(tx, event, owner, options.digestWindowMinutes);
  };
}
