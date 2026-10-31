import { Inject, Injectable } from '@nestjs/common';
import {
  AddressSuppressedError,
  addressDomain,
  assertCan,
  bareAddress,
  buildMessageId,
  ConflictError,
  ConsentWithdrawnError,
  EMAIL_LIMITS,
  EmailPausedError,
  emailLimitsFor,
  ForbiddenError,
  isValidBody,
  isValidFromName,
  isValidReplyTo,
  isValidSubject,
  localDay,
  newId,
  NoEmailAddressError,
  normalizeSingleLine,
  NotFoundError,
  RateLimitedError,
  renderEmailMergeFields,
  secondsUntilLocalMidnight,
  tenantAgeDays,
  ValidationError,
  type Actor,
  type EmailMergeValues,
  type EmailRecipient,
  type EmailSourceType,
} from '@crm/core';
import type {
  EmailContext,
  EmailContextQuery,
  EmailListQuery,
  EmailMessage,
  EmailSendInput,
  EmailUsage,
} from '@crm/contracts';
import { isConstraintViolation } from '../../common/db-errors.js';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { IdempotencyService } from '../../platform/idempotency.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { TenantClock } from '../../platform/tenant-clock.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { DealsService } from '../deals/deals.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { emailSuppressionKey, type Tx } from '@crm/db';
import type { EmailMessageRow, NewEmailMessageRow } from '@crm/db';
import { EmailsRepository, type EmailListRow } from './emails.repository.js';

interface Target {
  readonly objectType: EmailSourceType;
  readonly recordId: string;
  readonly contactId?: string | undefined;
}

interface Resolved {
  readonly recipient: EmailRecipient;
  /** The records the email is linked to: what it was sent from, and for a deal the person too. */
  readonly links: readonly { objectType: EmailSourceType; recordId: string }[];
  /** The contact it is written to, when there is one. */
  readonly contactId: string | null;
  /** The deal's name, for a deal and when the caller may read it. */
  readonly dealName: string | null;
}

/** The sender as it will appear, with whether the company has set it up yet. */
interface Sender {
  readonly fromName: string;
  readonly replyTo: string;
  readonly configured: boolean;
  /** The person's own name and the company's, for the merge fields (ADR-0074). */
  readonly userName: string;
  readonly companyName: string;
}

/**
 * Email sent from a record, and the log of it (ADR-0073).
 *
 * What this module decides: who may send and read, to whom an email goes, whether it may go, and what
 * is written down. What it never does: send. It queues a row and an outbox event in the request's
 * transaction (ADR-0006) and the worker talks to the mail service, so a slow or failing provider is
 * never a slow or failing request, and a rolled-back request sends nothing.
 *
 * The rule that matters: **a person may only email, and only read the emails of, records they can
 * see.** Both go through the record's own module (`emailRecipientInTx`, `getByIdInTx`), so the scope,
 * the 404 for what is out of scope and the field rules are exactly the ones the record page has, not a
 * second reading of them.
 */
@Injectable()
export class EmailsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailsRepository) private readonly repository: EmailsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(TenantClock) private readonly clock: TenantClock,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(DealsService) private readonly deals: DealsService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /** The address mail is sent from: the outreach address, or the system one when none is set. */
  sendingAddress(): string | null {
    return bareAddress(this.env.EMAIL_OUTREACH_FROM ?? this.env.EMAIL_FROM);
  }

  // ---- reading --------------------------------------------------------------------------------

  /** What the Send dialog needs before it is filled in. */
  async context(actor: Actor, query: EmailContextQuery): Promise<EmailContext> {
    return this.inTenant(actor, async (tx) => {
      await this.requireFeatureAndGrant(tx, actor, 'create');
      const resolved = await this.resolve(tx, actor, query);
      const sender = await this.senderFor(tx, actor);
      const signature = await this.repository.findSignature(tx, actor.tenantId, actor.userId);
      return {
        to: resolved.recipient.email,
        toName: resolved.recipient.name,
        consent: resolved.recipient.consent,
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        usage: await this.usageFor(tx, actor),
        senderConfigured: sender.configured,
        mergeValues: await this.mergeValuesFor(tx, actor, resolved, sender),
        signature: signature?.signatureText ?? '',
        suppressed: await this.suppressionOf(tx, actor, resolved.recipient.email),
        paused: (await this.repository.findLivePause(tx, actor.tenantId)) !== null,
      };
    });
  }

  async list(
    actor: Actor,
    query: EmailListQuery,
  ): Promise<{ data: EmailMessage[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      throw new ValidationError([{ path: 'cursor', message: 'Not a valid cursor' }]);
    }
    return this.inTenant(actor, async (tx) => {
      await this.requireFeatureAndGrant(tx, actor, 'read');
      // The record itself must be visible to this reader: out of scope is a 404, never an empty list.
      await this.assertVisible(tx, actor, query.objectType, query.recordId);

      const rows = await this.repository.listForRecord(
        tx,
        actor.tenantId,
        query.objectType,
        query.recordId,
        cursor,
        query.limit,
      );
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      return {
        data: page.map((row) => toDto(row)),
        meta: {
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({ value: last.cursorValue, id: last.message.id })
              : null,
          hasMore,
        },
      };
    });
  }

  async getById(actor: Actor, id: string): Promise<EmailMessage> {
    return this.inTenant(actor, (tx) => this.getByIdInTx(actor, tx, id));
  }

  async getByIdInTx(actor: Actor, tx: Tx, id: string): Promise<EmailMessage> {
    await this.requireFeatureAndGrant(tx, actor, 'read');
    const message = await this.visibleMessage(tx, actor, id);
    return this.dtoFor(tx, message);
  }

  // ---- sending --------------------------------------------------------------------------------

  async send(actor: Actor, input: EmailSendInput, idempotencyKey?: string): Promise<EmailMessage> {
    return this.inTenant(actor, (tx) =>
      this.idempotency.once(
        tx,
        actor,
        idempotencyKey,
        { objectType: 'email_message', action: 'send' },
        input,
        async () => {
          const email = await this.queueInTx(actor, tx, input, null);
          return { answer: email, reference: { recordId: email.id } };
        },
        (reference) => this.getByIdInTx(actor, tx, reference.recordId),
      ),
    );
  }

  async retry(actor: Actor, id: string, idempotencyKey?: string): Promise<EmailMessage> {
    return this.inTenant(actor, (tx) =>
      this.idempotency.once(
        tx,
        actor,
        idempotencyKey,
        { objectType: 'email_message', action: 'retry' },
        { id },
        async () => {
          await this.requireFeatureAndGrant(tx, actor, 'create');
          const original = await this.visibleMessage(tx, actor, id);
          if (original.status !== 'failed') {
            throw new ConflictError('Only an email that failed can be tried again');
          }
          if (original.erasedAt !== null) {
            throw new ConflictError('This email can no longer be sent: its content was erased');
          }
          if ((await this.repository.retryOf(tx, actor.tenantId, id)) !== null) {
            throw new ConflictError('This email has already been tried again');
          }
          const email = await this.queueInTx(
            actor,
            tx,
            {
              objectType: original.sourceObjectType,
              recordId: original.sourceRecordId,
              ...(original.sourceObjectType === 'deal' && original.contactId !== null
                ? { contactId: original.contactId }
                : {}),
              subject: original.subject,
              body: original.bodyText,
            },
            id,
          );
          return { answer: email, reference: { recordId: email.id } };
        },
        (reference) => this.getByIdInTx(actor, tx, reference.recordId),
      ),
    );
  }

  /**
   * Check, spend a send, and queue: all in the caller's transaction, so a refused or rolled-back
   * request leaves no message and no spent send.
   */
  private async queueInTx(
    actor: Actor,
    tx: Tx,
    input: EmailSendInput,
    retryOf: string | null,
  ): Promise<EmailMessage> {
    await this.requireFeatureAndGrant(tx, actor, 'create');

    const resolved = await this.resolve(tx, actor, input);
    const to = resolved.recipient.email;
    if (to === null || to.trim() === '') throw new NoEmailAddressError();
    if (resolved.recipient.consent === 'withdrawn') throw new ConsentWithdrawnError();

    // Two refusals that are not about the words: the company's email is paused, or this address is blocked.
    if ((await this.repository.findLivePause(tx, actor.tenantId)) !== null) {
      throw new EmailPausedError();
    }
    const blocked = await this.repository.findLiveSuppression(
      tx,
      actor.tenantId,
      emailSuppressionKey(actor.tenantId, to),
    );
    if (blocked !== null) throw new AddressSuppressedError(blocked.reason);

    const sender = await this.senderFor(tx, actor);
    const fromAddress = this.sendingAddress();
    const domain = fromAddress === null ? null : addressDomain(fromAddress);
    if (fromAddress === null || domain === null) {
      // Nothing to send as. Said plainly instead of queueing a message that can only fail.
      throw new ConflictError('Email sending is not set up on this installation');
    }

    // The words that are sent: merge fields filled from records this person may read, and their
    // signature below. A retry sends the stored words as they were, so nothing is filled or added twice.
    const words =
      retryOf === null
        ? await this.compose(tx, actor, input, resolved, sender)
        : { subject: input.subject, body: input.body };

    await this.spendOne(tx, actor);

    const id = newId();
    const now = new Date();
    const row: NewEmailMessageRow = {
      id,
      tenantId: actor.tenantId,
      direction: 'outbound',
      status: 'queued',
      sourceObjectType: input.objectType,
      sourceRecordId: input.recordId,
      contactId: resolved.contactId,
      fromName: sender.fromName,
      fromAddress,
      replyTo: sender.replyTo,
      toAddress: to,
      subject: words.subject,
      bodyText: words.body,
      messageId: buildMessageId(id, domain),
      attempts: 0,
      retryOf,
      queuedAt: now,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    };

    let message: EmailMessageRow;
    try {
      message = await this.repository.insertMessage(tx, row);
    } catch (error) {
      if (isConstraintViolation(error, 'email_messages_retry_key')) {
        throw new ConflictError('This email has already been tried again');
      }
      throw error;
    }
    await this.repository.insertLinks(
      tx,
      resolved.links.map((link) => ({
        id: newId(),
        tenantId: actor.tenantId,
        emailMessageId: id,
        objectType: link.objectType,
        recordId: link.recordId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })),
    );

    // Ids and words only: no address, subject or body goes into the audit log or an event (ADR-0073).
    await this.audit.record(tx, actor, {
      action: 'create',
      objectType: 'email_message',
      recordId: id,
      changes: {
        status: { new: 'queued' },
        source: { new: `${input.objectType}:${input.recordId}` },
        ...(retryOf === null ? {} : { retryOf: { new: retryOf } }),
      },
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'email.queued.v1',
      objectType: 'email_message',
      recordId: id,
      payload: {
        emailId: id,
        sourceObjectType: input.objectType,
        sourceRecordId: input.recordId,
      },
    });

    // A dead-man's switch: if this message is still unfinished in ten minutes (a worker crashed, an
    // event was lost) the worker looks at it again. Dated to the future, so nothing polls (ADR-0025).
    await this.outbox.publish(
      tx,
      actor,
      {
        eventType: 'email.watchdog_due.v1',
        objectType: 'email_message',
        recordId: id,
        payload: { emailId: id },
      },
      { availableAt: new Date(now.getTime() + 10 * 60_000) },
    );

    return this.dtoFor(tx, message);
  }

  /**
   * Take one send from today's allowance, or refuse with a 429 that says when it resets.
   *
   * Counted in the database, in this transaction, under a lock per workspace and day, so two people
   * at the company limit cannot both pass it, and a refused request spends nothing. The burst check
   * comes after the spend so it runs while this person's counter row is held: their own sends are
   * serialised, and "ten in a minute" cannot be raced.
   */
  private async spendOne(tx: Tx, actor: Actor): Promise<void> {
    const facts = await this.repository.tenantFacts(tx, actor.tenantId);
    const now = new Date();
    const zone = await this.clock.timeZone(tx, actor.tenantId);
    const day = localDay(now, zone);
    const limits = emailLimitsFor(tenantAgeDays(facts.createdAt, now));
    const retryAfter = secondsUntilLocalMidnight(now, zone);

    await this.repository.lockTenantDay(tx, actor.tenantId, day);
    const sent = await this.repository.sentToday(tx, actor.tenantId, actor.userId, day);
    if (sent.tenant >= limits.perTenant) {
      throw new RateLimitedError(
        `Your company has reached today's limit of ${String(limits.perTenant)} emails`,
        retryAfter,
      );
    }
    if (!(await this.repository.spendOne(tx, actor.tenantId, actor.userId, day, limits.perUser))) {
      throw new RateLimitedError(
        `You have reached today's limit of ${String(limits.perUser)} emails`,
        retryAfter,
      );
    }
    if (
      (await this.repository.startedInLastMinute(tx, actor.tenantId, actor.userId)) >=
      EMAIL_LIMITS.burstPerMinute
    ) {
      throw new RateLimitedError('You are sending too fast. Wait a minute and try again.', 60);
    }
  }

  // ---- who and as whom ----------------------------------------------------------------------------

  /** Today's use and the limits, for the dialog and the settings screen. */
  async usageFor(tx: Tx, actor: Actor): Promise<EmailUsage> {
    const facts = await this.repository.tenantFacts(tx, actor.tenantId);
    const now = new Date();
    const zone = await this.clock.timeZone(tx, actor.tenantId);
    const limits = emailLimitsFor(tenantAgeDays(facts.createdAt, now));
    const sent = await this.repository.sentToday(
      tx,
      actor.tenantId,
      actor.userId,
      localDay(now, zone),
    );
    return {
      sentToday: sent.user,
      limitPerUser: limits.perUser,
      tenantSentToday: sent.tenant,
      limitPerTenant: limits.perTenant,
    };
  }

  /**
   * The name mail goes out under, and where a reply goes.
   *
   * The company's saved sender when there is one. Before that, the company's own name (cleaned of
   * anything a From name may not hold) and the sender's own sign-in address, so the feature works the
   * moment it is switched on, and a reply reaches the person who wrote.
   */
  async senderFor(tx: Tx, actor: Actor): Promise<Sender> {
    const config = await this.repository.findConfig(tx, actor.tenantId);
    const user = await this.repository.userFacts(tx, actor.userId);
    const facts = await this.repository.tenantFacts(tx, actor.tenantId);

    const fromName =
      config?.fromName ??
      [cleanFromName(facts.name), cleanFromName(user?.name ?? '')].find((name) =>
        isValidFromName(name),
      );
    const replyTo = config?.replyTo ?? user?.email ?? null;
    if (fromName === undefined || replyTo === null || !isValidReplyTo(replyTo)) {
      throw new ValidationError([
        { path: 'sender', message: 'Set the name and reply address email is sent under first' },
      ]);
    }
    return {
      fromName,
      replyTo,
      configured: config !== null,
      userName: user?.name ?? '',
      companyName: facts.name,
    };
  }

  /**
   * What each merge field is for this person, from records the caller may read (ADR-0074).
   *
   * A value the caller may not read, or that the record does not have, is an empty string: the same
   * answer, so a hidden field cannot be told apart from an empty one. Every value goes through the
   * record's own module as the caller, never around it.
   */
  private async mergeValuesFor(
    tx: Tx,
    actor: Actor,
    resolved: Resolved,
    sender: Sender,
  ): Promise<Record<string, string>> {
    const recipient = resolved.recipient;
    let accountName = recipient.company ?? '';
    if (recipient.accountId !== undefined && recipient.accountId !== null) {
      try {
        const account = await this.accounts.getByIdInTx(actor, tx, recipient.accountId);
        if (typeof account['name'] === 'string') accountName = account['name'];
      } catch (error) {
        // An account the caller cannot see is an empty field, not an error.
        if (!(error instanceof NotFoundError) && !(error instanceof ForbiddenError)) throw error;
      }
    }
    return {
      'contact.first_name': recipient.firstName ?? '',
      'contact.last_name': recipient.lastName ?? '',
      'account.name': accountName,
      'deal.name': resolved.dealName ?? '',
      'sender.name': sender.userName,
      'company.name': sender.companyName,
    };
  }

  /** The subject and message as they will be sent, or a 422 saying which one cannot be. */
  private async compose(
    tx: Tx,
    actor: Actor,
    input: EmailSendInput,
    resolved: Resolved,
    sender: Sender,
  ): Promise<{ subject: string; body: string }> {
    const values = (await this.mergeValuesFor(tx, actor, resolved, sender)) as EmailMergeValues;
    const subject = normalizeSingleLine(renderEmailMergeFields(input.subject, values));
    const signature = (await this.repository.findSignature(tx, actor.tenantId, actor.userId))
      ?.signatureText;
    const filled = renderEmailMergeFields(input.body, values);
    const body =
      signature === undefined || signature.trim() === ''
        ? filled
        : `${filled.trimEnd()}\n\n${signature.trim()}`;

    const problems = [
      ...(isValidSubject(subject)
        ? []
        : [
            {
              path: 'subject',
              message: 'The subject is empty or too long once its fields are filled in',
            },
          ]),
      ...(isValidBody(body)
        ? []
        : [
            {
              path: 'body',
              message:
                'The message is empty or too long once its fields and your signature are added',
            },
          ]),
    ];
    if (problems.length > 0) throw new ValidationError(problems);
    return { subject, body };
  }

  /** Whether this address is blocked, and why, as the context answers it. Null for no address, or not blocked. */
  private async suppressionOf(
    tx: Tx,
    actor: Actor,
    address: string | null,
  ): Promise<EmailContext['suppressed']> {
    if (address === null) return null;
    const live = await this.repository.findLiveSuppression(
      tx,
      actor.tenantId,
      emailSuppressionKey(actor.tenantId, address),
    );
    return live === null ? null : { reason: live.reason, since: live.createdAt.toISOString() };
  }

  /** The footer the company appends to every email, or null. */
  async footerFor(tx: Tx, tenantId: string): Promise<string | null> {
    return (await this.repository.findConfig(tx, tenantId))?.footerText ?? null;
  }

  // ---- the record an email is about ---------------------------------------------------------------

  /**
   * Who an email from this record goes to, and what it is linked to.
   *
   * Always through the record's own module, as the caller: scope, the 404, and the field rules are its
   * own. The address is the record's, never the client's.
   */
  private async resolve(tx: Tx, actor: Actor, target: Target): Promise<Resolved> {
    if (target.objectType === 'contact') {
      const recipient = await this.contacts.emailRecipientInTx(actor, tx, target.recordId);
      return {
        recipient,
        links: [{ objectType: 'contact', recordId: target.recordId }],
        contactId: target.recordId,
        dealName: null,
      };
    }
    if (target.objectType === 'lead') {
      const recipient = await this.leads.emailRecipientInTx(actor, tx, target.recordId);
      return {
        recipient,
        links: [{ objectType: 'lead', recordId: target.recordId }],
        contactId: null,
        dealName: null,
      };
    }

    // A deal: the person is one of the deal's own contacts, and the deal must be visible to the caller.
    const deal = await this.deals.getByIdInTx(actor, tx, target.recordId);
    const people = new Set<string>();
    if (typeof deal['primaryContactId'] === 'string') people.add(deal['primaryContactId']);
    if (Array.isArray(deal['contacts'])) {
      for (const person of deal['contacts'] as { contactId?: unknown }[]) {
        if (typeof person.contactId === 'string') people.add(person.contactId);
      }
    }
    if (target.contactId === undefined || !people.has(target.contactId)) {
      throw new NotFoundError('Contact');
    }
    const recipient = await this.contacts.emailRecipientInTx(actor, tx, target.contactId);
    return {
      recipient,
      links: [
        { objectType: 'deal', recordId: target.recordId },
        { objectType: 'contact', recordId: target.contactId },
      ],
      contactId: target.contactId,
      dealName: typeof deal['name'] === 'string' ? deal['name'] : null,
    };
  }

  /** 404 unless the record exists and is in the caller's scope. */
  private async assertVisible(
    tx: Tx,
    actor: Actor,
    objectType: EmailSourceType,
    recordId: string,
  ): Promise<void> {
    if (objectType === 'contact') await this.contacts.emailRecipientInTx(actor, tx, recordId);
    else if (objectType === 'lead') await this.leads.emailRecipientInTx(actor, tx, recordId);
    else await this.deals.getByIdInTx(actor, tx, recordId);
  }

  /**
   * A message the caller may see: one linked to at least one record they can read. Anything else is
   * a 404, so the id cannot be used to find out that an email exists.
   */
  private async visibleMessage(tx: Tx, actor: Actor, id: string): Promise<EmailMessageRow> {
    const message = await this.repository.findMessage(tx, actor.tenantId, id);
    if (message === null) throw new NotFoundError('Email');
    const links = await this.repository.linksOf(tx, actor.tenantId, id);
    for (const link of links) {
      if (!isSourceType(link.objectType)) continue;
      try {
        await this.assertVisible(tx, actor, link.objectType, link.recordId);
        return message;
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError) continue;
        throw error;
      }
    }
    throw new NotFoundError('Email');
  }

  private async dtoFor(tx: Tx, message: EmailMessageRow): Promise<EmailMessage> {
    const names = await this.repository.senderNames(
      tx,
      message.createdBy === null ? [] : [message.createdBy],
    );
    const retriedById = await this.repository.retryOf(tx, message.tenantId, message.id);
    return toDto({
      message,
      sentByName: message.createdBy === null ? null : (names.get(message.createdBy) ?? null),
      retriedById,
      cursorValue: '',
    });
  }

  // ---- permissions and plan -------------------------------------------------------------------------

  private async requireFeatureAndGrant(
    tx: Tx,
    actor: Actor,
    action: 'read' | 'create',
  ): Promise<void> {
    assertCan(actor, action, { objectType: 'email_message' });
    await this.entitlements.require(tx, actor.tenantId, 'email');
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function isSourceType(value: string): value is EmailSourceType {
  return value === 'contact' || value === 'lead' || value === 'deal';
}

/** A company or person name reduced to what a From name may hold. */
function cleanFromName(name: string): string {
  return normalizeSingleLine(name.replace(/[^\p{L}\p{N} .,&'()\-/]/gu, ' '))
    .slice(0, 80)
    .trim();
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toDto(row: EmailListRow): EmailMessage {
  const m = row.message;
  return {
    id: m.id,
    direction: m.direction,
    status: m.status,
    fromName: m.fromName,
    toAddress: m.toAddress,
    replyTo: m.replyTo,
    subject: m.subject,
    body: m.bodyText,
    failureCode: (m.failureCode as EmailMessage['failureCode']) ?? null,
    bounceReason: (m.bounceReason as EmailMessage['bounceReason']) ?? null,
    erased: m.erasedAt !== null,
    contactId: m.contactId,
    sentById: m.createdBy,
    sentByName: row.sentByName,
    queuedAt: m.queuedAt.toISOString(),
    sentAt: iso(m.sentAt),
    failedAt: iso(m.failedAt),
    retryOfId: m.retryOf,
    retriedById: row.retriedById,
  };
}
