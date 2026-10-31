import { Inject, Injectable } from '@nestjs/common';
import { newId, NotFoundError, RateLimitedError } from '@crm/core';
import { verifyUnsubscribeToken } from '@crm/core/email-unsubscribe-token';
import type { EmailUnsubscribePage } from '@crm/contracts';
import { unsubscribeVerifySecrets } from '../../common/unsubscribe-secrets.js';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import {
  RATE_LIMIT_COUNTER,
  rateLimitKey,
  type RateLimitCounter,
} from '../../platform/rate-limit/counter.js';
import { EmailUnsubscribeRepository } from './email-unsubscribe.repository.js';

/** The name this door's records are kept under. Not a provider's: it is the person's own click. */
const SOURCE = 'unsubscribe_link';

/** One link may be used this many times in an hour. A person needs once; a mail scanner a few. */
const PER_LINK_PER_HOUR = 20;
const WINDOW_SECONDS = 3600;

/**
 * The link at the foot of every email (ADR-0076). **A stranger reaches this**, so what it does is narrow, and
 * in this order:
 *
 *   1. the token's signature is checked first, with no database: anything not signed by this installation, a
 *      changed id, a made-up value, is the one answer "not found";
 *   2. the company is found from a database row the signed id names (a column-limited read as the routing
 *      role), never from the request; an email that is gone, or a company that is suspended, is the same answer;
 *   3. opening the page changes nothing, because mail scanners open every link;
 *   4. the unsubscribe itself is recorded once, in that company's own transaction, with one outbox event for
 *      the worker to apply. A second use is recognised and does nothing.
 *
 * It decides nothing about an address or a person: the worker blocks the address, withdraws consent, audits and
 * files the timeline line, under row-level security, with the rights it already has. What is written holds ids
 * and a type, never an address.
 */
@Injectable()
export class EmailUnsubscribeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailUnsubscribeRepository) private readonly repository: EmailUnsubscribeRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /** What the page needs to ask its question. Changes nothing. */
  async page(token: string): Promise<EmailUnsubscribePage> {
    const link = await this.resolve(token);
    return { companyName: link.companyName };
  }

  /** Stop email to the person this email was sent to. Doing it twice is harmless. */
  async unsubscribe(token: string): Promise<void> {
    const link = await this.resolve(token);
    await this.spend(link.emailId);

    const identity = { tenantId: link.tenantId, userId: null };
    await this.database.runInTenant(identity, async (tx) => {
      const first = await this.repository.insertEvent(tx, {
        id: newId(),
        tenantId: link.tenantId,
        provider: SOURCE,
        providerEventId: link.emailId,
        emailMessageId: link.emailId,
        eventType: 'unsubscribed',
      });
      if (!first) return;
      await this.outbox.publish(tx, identity, {
        eventType: 'email.provider_event.v1',
        objectType: 'email_message',
        recordId: link.emailId,
        payload: {
          emailId: link.emailId,
          eventType: 'unsubscribed',
          reason: null,
          at: new Date().toISOString(),
        },
      });
    });
  }

  private async resolve(
    token: string,
  ): Promise<{ emailId: string; tenantId: string; companyName: string }> {
    const emailId = verifyUnsubscribeToken(unsubscribeVerifySecrets(this.env), token);
    if (emailId === null) throw notValid();
    const routed = await this.database.runAsAuth((tx) => this.repository.routeEmailId(tx, emailId));
    if (routed === null) throw notValid();
    const companyName = await this.database.runInTenant(
      { tenantId: routed.tenantId, userId: null },
      (tx) => this.repository.senderNameOf(tx, routed.tenantId, emailId),
    );
    if (companyName === null) throw notValid();
    return { emailId, tenantId: routed.tenantId, companyName };
  }

  private async spend(emailId: string): Promise<void> {
    const [hit] = await this.counter.hitMany([
      { key: rateLimitKey('public-unsubscribe', emailId), windowSeconds: WINDOW_SECONDS },
    ]);
    if (hit !== undefined && hit.count > PER_LINK_PER_HOUR) {
      throw new RateLimitedError('Too many requests. Try again shortly.', hit.retryAfterSeconds);
    }
  }
}

/** One answer for every failed check, so nothing says which part was wrong. */
function notValid(): NotFoundError {
  return new NotFoundError('Unsubscribe link');
}
