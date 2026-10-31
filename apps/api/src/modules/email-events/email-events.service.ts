import { Inject, Injectable } from '@nestjs/common';
import { newId, NotFoundError, UnauthenticatedError } from '@crm/core';
import { verifyResendEvents } from '@crm/outbound';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { EmailEventsRepository } from './email-events.repository.js';

/** The providers whose reports we read. Only the name of an adapter is ever a valid path. */
const PROVIDER = 'resend';

/**
 * Where the mail service tells us what happened to an email (ADR-0075).
 *
 * **A stranger reaches this**, so what it does is narrow and in this order:
 *
 *   1. an unknown provider, or one with no secret configured, is the one answer "not found";
 *   2. the signature is checked over the raw bytes before the body is looked at, and a bad or stale one
 *      is a fixed 401 that writes nothing;
 *   3. each event names only the provider's id for an email, so the company is found from a database
 *      row (a column-limited read as the routing role), never from the request;
 *   4. in that company's own transaction the event is recorded once (a replay is recognised and does
 *      nothing) and one outbox event is written for the worker to apply.
 *
 * It decides nothing about an email, a status or an address: the worker does, under row-level security,
 * with the narrow rights it already has. What is written holds ids, a type and a closed reason, and never
 * an address, a subject or the provider's own words.
 */
@Injectable()
export class EmailEventsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailEventsRepository) private readonly repository: EmailEventsRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  async receive(
    provider: string,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    rawBody: string | null,
  ): Promise<void> {
    const secret = this.env.RESEND_WEBHOOK_SECRET;
    if (provider !== PROVIDER || secret === undefined || secret === '') {
      throw new NotFoundError('Email provider');
    }
    if (rawBody === null) throw invalid();

    const verified = verifyResendEvents({ secret, headers, rawBody, now: new Date() });
    if (!verified.ok) throw invalid();

    for (const event of verified.events) {
      const routed = await this.database.runAsAuth((tx) =>
        this.repository.routeProviderId(tx, event.providerMessageId),
      );
      // An email we do not know (another application on the same account, a test, one we have not saved
      // yet) is not an error: the provider is told it was received either way.
      if (routed === null) continue;

      const identity = { tenantId: routed.tenantId, userId: null };
      await this.database.runInTenant(identity, async (tx) => {
        const first = await this.repository.insertProviderEvent(tx, {
          id: newId(),
          tenantId: routed.tenantId,
          provider: PROVIDER,
          providerEventId: event.providerEventId,
          emailMessageId: routed.messageId,
          eventType: event.type,
        });
        if (!first) return;
        await this.outbox.publish(tx, identity, {
          eventType: 'email.provider_event.v1',
          objectType: 'email_message',
          recordId: routed.messageId,
          payload: {
            emailId: routed.messageId,
            eventType: event.type,
            reason: event.reason,
            at: event.at.toISOString(),
          },
        });
      });
    }
  }
}

/** One fixed answer for every failed check, so nothing says which part was wrong. */
function invalid(): UnauthenticatedError {
  return new UnauthenticatedError('This request could not be verified');
}
