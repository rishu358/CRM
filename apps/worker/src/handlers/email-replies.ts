import {
  EMAIL_REPLY_LIMITS,
  newId,
  shapeReceivedEmail,
  type InboundEmailProvider,
  type ReceivedEmail,
} from '@crm/core';
import { EmailFetchError } from '@crm/outbound';
import {
  and,
  auditLogs,
  emailMessageLinks,
  emailMessages,
  eq,
  outboxEvents,
  sql,
  withTenant,
  type Database,
  type EmailMessageRow,
} from '@crm/db';
import type { Logger } from 'pino';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * Filing a customer's reply on the record (ADR-0077).
 *
 * The public door has already checked the signature, found the company from the reply address and recorded the
 * event once. What reaches here is: **which sent email it answers** and **Resend's id for the received message**.
 * The words are not in the event, so this fetches them, and it does that the way the send does, in three short
 * transactions with the network call in none:
 *
 *   1. **Look.** The sent email is still there; this received message is not already filed; the per-email and
 *      per-company limits are not reached. Anything else stops here, quietly, with a log line of ids only.
 *   2. **Fetch**, through the receiving adapter. A temporary failure throws, so the relay tries again with its
 *      backoff; a permanent one, or a message that cannot be shaped, is dropped.
 *   3. **File.** One row (inbound, `received`), linked to the records the sent email is linked to, an audit entry
 *      and one timeline event, in one transaction. A second delivery of the same event finds the row (the
 *      database refuses a second, by Resend's id and by the sender's own `Message-ID`) and files nothing.
 *
 * **Nothing in a reply is trusted.** The sender is stored as claimed. The body is the plain-text part only,
 * cut to the log's limit; no HTML is ever stored. Nothing here changes a status, a consent or a record, and
 * nothing written to an event, the audit log or the timeline holds the address, the subject or the words.
 */

export interface EmailReplyDeps {
  readonly db: Database;
  readonly inbound: InboundEmailProvider;
  readonly logger: Logger;
  /** Our own sending addresses, lower-cased: mail that claims to come from one of them is a loop and is dropped. */
  readonly ownAddresses: readonly string[];
}

type Looked =
  | { readonly kind: 'ok'; readonly original: EmailMessageRow; readonly links: LinkRow[] }
  | { readonly kind: 'stop'; readonly why: string };

interface LinkRow {
  readonly objectType: (typeof emailMessageLinks.$inferSelect)['objectType'];
  readonly recordId: string;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function fileReply(deps: EmailReplyDeps): EventHandler {
  return async (_tx, event: OutboxRow): Promise<void> => {
    const emailId = textOf(event.payload['emailId']);
    const providerEmailId = textOf(event.payload['providerEmailId']);
    if (emailId === null || providerEmailId === null) return;
    const scope = { tenantId: event.tenant_id, userId: null };

    // 1. Look.
    const looked = await withTenant(deps.db, scope, async (tx): Promise<Looked> => {
      const rows = await tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, event.tenant_id),
            eq(emailMessages.id, emailId),
            eq(emailMessages.direction, 'outbound'),
          ),
        )
        .limit(1);
      const original = rows[0];
      if (original === undefined) return { kind: 'stop', why: 'the sent email is gone' };
      // The person it was sent to has been erased: there is nothing left to file a reply under.
      if (original.erasedAt !== null) return { kind: 'stop', why: 'the sent email was erased' };

      const filed = await tx
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, event.tenant_id),
            eq(emailMessages.direction, 'inbound'),
            eq(emailMessages.providerMessageId, providerEmailId),
          ),
        )
        .limit(1);
      if (filed.length > 0) return { kind: 'stop', why: 'already filed' };

      const counts = await tx.execute(sql`
        select
          (select count(*)::int from email_messages
            where tenant_id = ${event.tenant_id}::uuid and reply_to_email_id = ${emailId}::uuid) as per_email,
          (select count(*)::int from email_messages
            where tenant_id = ${event.tenant_id}::uuid and direction = 'inbound'
              and created_at > now() - interval '24 hours') as per_day
      `);
      const row = counts.rows[0] as unknown as { per_email: number; per_day: number } | undefined;
      if ((row?.per_email ?? 0) >= EMAIL_REPLY_LIMITS.perEmail) {
        return { kind: 'stop', why: 'the limit of replies to one email is reached' };
      }
      if ((row?.per_day ?? 0) >= EMAIL_REPLY_LIMITS.perCompanyPerDay) {
        return { kind: 'stop', why: 'the company’s daily limit of replies is reached' };
      }

      const links = await tx
        .select({ objectType: emailMessageLinks.objectType, recordId: emailMessageLinks.recordId })
        .from(emailMessageLinks)
        .where(
          and(
            eq(emailMessageLinks.tenantId, event.tenant_id),
            eq(emailMessageLinks.emailMessageId, emailId),
          ),
        );
      return { kind: 'ok', original, links };
    });
    if (looked.kind === 'stop') {
      deps.logger.info({ emailId, why: looked.why }, 'Reply not filed');
      return;
    }

    // 2. Fetch. No transaction of ours is open here.
    let received: ReceivedEmail;
    try {
      received = await deps.inbound.retrieve(providerEmailId);
    } catch (error) {
      const retryable = error instanceof EmailFetchError && error.retryable;
      // The address, subject and words are never logged (CLAUDE.md §5.8): ids and a code are enough.
      deps.logger.warn(
        {
          emailId,
          providerEmailId,
          status: error instanceof EmailFetchError ? error.status : null,
          retryable,
        },
        'Reply could not be fetched',
      );
      if (retryable) throw error;
      return;
    }

    const shaped = shapeReceivedEmail(received);
    if (shaped === null) {
      deps.logger.warn({ emailId, providerEmailId }, 'Reply dropped: no usable sender');
      return;
    }
    if (deps.ownAddresses.includes(shaped.fromAddress)) {
      deps.logger.warn({ emailId, providerEmailId }, 'Reply dropped: it claims to be from us');
      return;
    }

    // 3. File.
    const { original, links } = looked;
    const messageId =
      usableMessageId(received.messageId) ?? `<reply-${providerEmailId}@received.invalid>`;
    await withTenant(deps.db, scope, async (tx) => {
      const id = newId();
      const inserted = await tx
        .insert(emailMessages)
        .values({
          id,
          tenantId: event.tenant_id,
          direction: 'inbound',
          status: 'received',
          sourceObjectType: original.sourceObjectType,
          sourceRecordId: original.sourceRecordId,
          contactId: original.contactId,
          fromName: shaped.fromName,
          fromAddress: shaped.fromAddress,
          // The row requires a recipient: the address the sent email asked answers to go to, which is the rep's.
          toAddress: original.replyTo ?? original.fromAddress,
          subject: shaped.subject,
          bodyText: shaped.body,
          messageId,
          providerMessageId: providerEmailId,
          replyToEmailId: original.id,
          attachmentCount: received.attachmentCount,
          bodyShortened: shaped.bodyShortened,
          queuedAt: new Date(),
        })
        // One received message is one row, however many times its event arrives or how many reply addresses it
        // was sent to (the database refuses a second by Resend's id and by the sender's own Message-ID).
        .onConflictDoNothing()
        .returning({ id: emailMessages.id });
      if (inserted.length === 0) return;

      if (links.length > 0) {
        await tx.insert(emailMessageLinks).values(
          links.map((link) => ({
            id: newId(),
            tenantId: event.tenant_id,
            emailMessageId: id,
            objectType: link.objectType,
            recordId: link.recordId,
          })),
        );
      }
      // Ids only: no address, subject or words go into the audit log or an event (ADR-0073).
      await tx.insert(auditLogs).values({
        id: newId(),
        tenantId: event.tenant_id,
        actorId: null,
        action: 'create',
        objectType: 'email_message',
        recordId: id,
        changes: {
          direction: { new: 'inbound' },
          replyTo: { new: original.id },
          source: { new: `${original.sourceObjectType}:${original.sourceRecordId}` },
        },
      });
      // On the record the sent email was sent from, so the timeline projection files it there (ADR-0005).
      await tx.insert(outboxEvents).values({
        id: newId(),
        tenantId: event.tenant_id,
        eventType: 'email.replied.v1',
        objectType: original.sourceObjectType,
        recordId: original.sourceRecordId,
        payload: { emailId: id, repliedToId: original.id },
        actorId: null,
      });
    });
  };
}

/** A sender's `Message-ID` as the log's unique key: one plain token, or nothing. */
function usableMessageId(value: string | null): string | null {
  if (value === null) return null;
  const id = value.trim();
  return /^<[^\s<>]{1,200}>$/.test(id) ? id : null;
}
