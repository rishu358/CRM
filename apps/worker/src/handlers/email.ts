import {
  isUnsubscribeTokenShape,
  newId,
  renderEmailHtml,
  renderEmailText,
  unsubscribeOneClickUrl,
  unsubscribePageUrl,
  type EmailFailureCode,
  type EmailProvider,
  type EmailUnsubscribe,
} from '@crm/core';
import { EmailSendError } from '@crm/outbound';
import {
  and,
  emailMessages,
  emailSenderConfig,
  eq,
  inArray,
  outboxEvents,
  sql,
  withTenant,
  type Database,
  type EmailMessageRow,
  type Tx,
} from '@crm/db';
import type { Logger } from 'pino';
import type { ExhaustedHandler, EventHandler, OutboxRow } from '../relay.js';

/**
 * Sending an email that a person queued from a record (ADR-0073).
 *
 * ## The send is outside every transaction, and happens at most once
 *
 * The relay runs a handler inside one transaction and delivers at least once. Sending mail from in
 * there would send, then fail to commit, and send again on the retry: a customer would get the same
 * email twice. So the handler works in three short transactions of its own, with the call to the mail
 * service between them and in none:
 *
 *   1. **Claim.** `queued` -> `sending`, in one statement that only one delivery can win. A second
 *      delivery, a retry that arrives late or a duplicate finds nothing to claim and stops.
 *   2. **Send.** No transaction is open.
 *   3. **Finish.** `sending` -> `sent` or `failed`, and an outbox event for the timeline.
 *
 * A crash between 2 and 3 leaves `sending`. That is deliberate: it is reported as "outcome unknown" and
 * the person decides, rather than the worker guessing and maybe mailing a customer twice. The watchdog
 * (below) is what notices.
 *
 * ## What is retried
 *
 * A failure the adapter says is temporary (a timeout, a 429, a 5xx) puts the message back to `queued`
 * and throws, so the relay tries again with its own backoff. Anything else is final: `failed` with a
 * code from a closed list and no more tries. A provider's own error text is never stored, because it
 * can repeat the address.
 *
 * The events written here carry ids and codes only: the timeline copies a payload whole, and an
 * erasure does not reach it, so an address, a subject or a body must never be in one.
 */

export interface EmailHandlerDeps {
  readonly db: Database;
  /** Sends as the outreach address (`EMAIL_OUTREACH_FROM`), not as the system one. */
  readonly email: EmailProvider;
  /**
   * The two public origins the unsubscribe link is built from (ADR-0076): the web app's page, and the API's
   * address a mail program posts to. Configuration, never a literal.
   */
  readonly origins: { readonly web: string; readonly api: string };
  readonly logger: Logger;
}

/** A message that has sat unfinished this long is looked at again by the watchdog. */
export const WATCHDOG_MINUTES = 10;
/** A `queued` message older than this is given up on. */
const GIVE_UP_MINUTES = 60;
/** A `sending` message older than this has lost its worker. */
const SENDING_STALE_MINUTES = 5;

function emailIdOf(event: OutboxRow): string | null {
  const id = event.payload['emailId'];
  return typeof id === 'string' ? id : event.record_id;
}

export function sendQueuedEmail(deps: EmailHandlerDeps): EventHandler {
  return async (_tx: Tx, event: OutboxRow): Promise<void> => {
    const id = emailIdOf(event);
    if (id === null) return;
    const scope = { tenantId: event.tenant_id, userId: event.actor_id };

    // 1. Claim, and read what is needed to build the message, in one short transaction.
    const claimed = await withTenant(deps.db, scope, async (tx) => {
      const rows = await tx
        .update(emailMessages)
        .set({
          status: 'sending',
          attempts: sqlPlusOne(),
          sendingStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailMessages.tenantId, event.tenant_id),
            eq(emailMessages.id, id),
            eq(emailMessages.status, 'queued'),
          ),
        )
        .returning();
      const message = rows[0];
      if (message === undefined) return null;
      const config = await tx
        .select({ footerText: emailSenderConfig.footerText })
        .from(emailSenderConfig)
        .where(eq(emailSenderConfig.tenantId, event.tenant_id))
        .limit(1);
      return { message, footer: config[0]?.footerText ?? null };
    });
    if (claimed === null) return;

    const { message, footer } = claimed;
    if (message.toAddress === null || message.erasedAt !== null) {
      // Scrubbed by an erasure between queueing and sending: there is nothing left to send.
      await finish(deps, event, message, { failure: 'rejected' });
      return;
    }

    // Every email says how to stop receiving them (ADR-0076). One queued before the link existed has no
    // token and goes without it; nothing is made up for it here, because the API signs the tokens.
    const token = isUnsubscribeTokenShape(message.unsubscribeToken)
      ? message.unsubscribeToken
      : null;
    const unsubscribe: EmailUnsubscribe | null =
      token === null
        ? null
        : { companyName: message.fromName, pageUrl: unsubscribePageUrl(deps.origins.web, token) };

    // 2. Send. No transaction is open here.
    let providerMessageId: string | null;
    try {
      const receipt = await deps.email.send({
        to: message.toAddress,
        subject: message.subject,
        text: renderEmailText(message.bodyText, footer, unsubscribe),
        html: renderEmailHtml(message.bodyText, footer, unsubscribe),
        fromName: message.fromName,
        ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
        messageId: message.messageId,
        ...(token === null
          ? {}
          : { unsubscribeUrl: unsubscribeOneClickUrl(deps.origins.api, token) }),
      });
      providerMessageId = receipt.providerMessageId ?? null;
    } catch (error) {
      const failure = classify(error);
      // The message and address are never logged (CLAUDE.md §5.8): the id and the code are enough.
      deps.logger.warn(
        { emailId: id, failure: failure.code, retryable: failure.retryable },
        'Email send failed',
      );
      if (failure.retryable) {
        await requeue(deps, event, message);
        throw error;
      }
      await finish(deps, event, message, { failure: failure.code });
      return;
    }

    // 3. Finish.
    await finish(deps, event, message, { providerMessageId });
  };
}

/**
 * The relay has given up on this email's send. Close it as failed so the person is told and may try
 * again, instead of leaving it queued for ever. Runs in no transaction of its own (see
 * `ExhaustedHandler`); `finish` opens one.
 */
export function failEmailOnExhaustion(deps: EmailHandlerDeps): ExhaustedHandler {
  return async (event) => {
    const id = emailIdOf(event);
    if (id === null) return;
    await settleStuck(deps, event, id, 'provider_unavailable', { includeQueued: true });
  };
}

/**
 * A dead-man's switch for one email, armed by the API ten minutes after it queues it.
 *
 * The relay does not re-claim an event a crashed worker left in `processing`, so without this a
 * message could stay `queued` or `sending` for ever. Scheduled through the outbox like every other
 * timed job (ADR-0025): nothing polls, nothing scans every workspace, and it survives a restart.
 *
 *   - `sending` for too long: the worker that held it is gone, and nobody knows whether the mail
 *     service got it. Marked `failed` / `outcome_unknown`.
 *   - `queued` for too long: its send event was lost. A fresh one is queued and the watchdog re-arms,
 *     until the message is an hour old, when it is given up on.
 *   - Anything finished: nothing to do.
 */
export function watchEmail(deps: EmailHandlerDeps): EventHandler {
  return async (_tx: Tx, event: OutboxRow): Promise<void> => {
    const id = emailIdOf(event);
    if (id === null) return;
    const scope = { tenantId: event.tenant_id, userId: event.actor_id };

    const message = await withTenant(deps.db, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(emailMessages)
        .where(and(eq(emailMessages.tenantId, event.tenant_id), eq(emailMessages.id, id)))
        .limit(1);
      return rows[0] ?? null;
    });
    if (message === null) return;

    const now = Date.now();
    if (message.status === 'sending') {
      const since = message.sendingStartedAt?.getTime() ?? message.updatedAt.getTime();
      if (now - since >= SENDING_STALE_MINUTES * 60_000) {
        await settleStuck(deps, event, id, 'outcome_unknown', { includeQueued: false });
      }
      return;
    }
    if (message.status !== 'queued') return;

    if (now - message.queuedAt.getTime() >= GIVE_UP_MINUTES * 60_000) {
      await settleStuck(deps, event, id, 'provider_unavailable', { includeQueued: true });
      return;
    }
    if (now - message.updatedAt.getTime() < (WATCHDOG_MINUTES - 1) * 60_000) {
      // Recently touched (a retry is waiting its turn): look again later.
      await withTenant(deps.db, scope, (tx) => armWatchdog(tx, event, message));
      return;
    }
    await withTenant(deps.db, scope, async (tx) => {
      await tx.insert(outboxEvents).values({
        id: newId(),
        tenantId: event.tenant_id,
        eventType: 'email.queued.v1',
        objectType: 'email_message',
        recordId: message.id,
        payload: { emailId: message.id },
        actorId: event.actor_id,
      });
      await armWatchdog(tx, event, message);
    });
  };
}

// ---- the three small steps ------------------------------------------------------------------------

async function armWatchdog(tx: Tx, event: OutboxRow, message: EmailMessageRow): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: newId(),
    tenantId: event.tenant_id,
    eventType: 'email.watchdog_due.v1',
    objectType: 'email_message',
    recordId: message.id,
    payload: { emailId: message.id },
    actorId: event.actor_id,
    availableAt: new Date(Date.now() + WATCHDOG_MINUTES * 60_000),
  });
}

/** Back to `queued` after a temporary failure, so the relay's retry can claim it again. */
async function requeue(
  deps: EmailHandlerDeps,
  event: OutboxRow,
  message: EmailMessageRow,
): Promise<void> {
  await withTenant(deps.db, { tenantId: event.tenant_id, userId: event.actor_id }, (tx) =>
    tx
      .update(emailMessages)
      .set({ status: 'queued', sendingStartedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(emailMessages.tenantId, event.tenant_id),
          eq(emailMessages.id, message.id),
          eq(emailMessages.status, 'sending'),
        ),
      ),
  );
}

async function finish(
  deps: EmailHandlerDeps,
  event: OutboxRow,
  message: EmailMessageRow,
  outcome: { providerMessageId: string | null } | { failure: EmailFailureCode },
): Promise<void> {
  const now = new Date();
  await withTenant(deps.db, { tenantId: event.tenant_id, userId: event.actor_id }, async (tx) => {
    const failed = 'failure' in outcome;
    const rows = await tx
      .update(emailMessages)
      .set(
        failed
          ? { status: 'failed', failureCode: outcome.failure, failedAt: now, updatedAt: now }
          : {
              status: 'sent',
              providerMessageId: outcome.providerMessageId,
              sentAt: now,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(emailMessages.tenantId, event.tenant_id),
          eq(emailMessages.id, message.id),
          eq(emailMessages.status, 'sending'),
        ),
      )
      .returning({ id: emailMessages.id });
    // Someone else already settled it (the watchdog, an exhaustion hook): say nothing twice.
    if (rows.length === 0) return;

    await tx.insert(outboxEvents).values({
      id: newId(),
      tenantId: event.tenant_id,
      eventType: failed ? 'email.failed.v1' : 'email.sent.v1',
      // On the record it was sent from, so the timeline projection files it there (ADR-0005).
      objectType: message.sourceObjectType,
      recordId: message.sourceRecordId,
      payload: failed
        ? { emailId: message.id, failureCode: outcome.failure }
        : { emailId: message.id },
      actorId: event.actor_id,
    });
  });
}

/** Close a message the normal path lost. A message that is already settled is left alone. */
async function settleStuck(
  deps: EmailHandlerDeps,
  event: OutboxRow,
  id: string,
  code: EmailFailureCode,
  options: { includeQueued: boolean },
): Promise<void> {
  const now = new Date();
  await withTenant(deps.db, { tenantId: event.tenant_id, userId: event.actor_id }, async (tx) => {
    const rows = await tx
      .update(emailMessages)
      .set({ status: 'failed', failureCode: code, failedAt: now, updatedAt: now })
      .where(
        and(
          eq(emailMessages.tenantId, event.tenant_id),
          eq(emailMessages.id, id),
          options.includeQueued ? inFlight() : eq(emailMessages.status, 'sending'),
        ),
      )
      .returning({
        id: emailMessages.id,
        sourceObjectType: emailMessages.sourceObjectType,
        sourceRecordId: emailMessages.sourceRecordId,
      });
    const row = rows[0];
    if (row === undefined) return;
    await tx.insert(outboxEvents).values({
      id: newId(),
      tenantId: event.tenant_id,
      eventType: 'email.failed.v1',
      objectType: row.sourceObjectType,
      recordId: row.sourceRecordId,
      payload: { emailId: row.id, failureCode: code },
      actorId: event.actor_id,
    });
  });
}

// ---- classifying a failure --------------------------------------------------------------------------

function classify(error: unknown): { code: EmailFailureCode; retryable: boolean } {
  if (!(error instanceof EmailSendError)) {
    // Not one of ours. We cannot tell whether the provider got the message, so say so and do not retry.
    return { code: 'outcome_unknown', retryable: false };
  }
  if (error.retryable) {
    return { code: error.status === null ? 'timeout' : 'provider_unavailable', retryable: true };
  }
  if (error.status !== null && [550, 551, 553].includes(error.status)) {
    return { code: 'invalid_recipient', retryable: false };
  }
  return { code: 'rejected', retryable: false };
}

function sqlPlusOne() {
  return sql`${emailMessages.attempts} + 1`;
}

function inFlight() {
  return inArray(emailMessages.status, ['queued', 'sending']);
}
