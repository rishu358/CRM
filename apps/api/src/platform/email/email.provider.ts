import { Inject, Injectable } from '@nestjs/common';
import type { EmailMessage, EmailProvider, EmailReceipt } from '@crm/core';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { createLogger } from '../../common/logger.js';
import { currentRequestContext } from '../../common/request-context.js';

/**
 * Outbound email, behind an interface (ADR-0009).
 *
 * No vendor SDK is imported outside an adapter, so swapping Resend for SES is
 * a new class and an env value, not a search through the codebase for
 * `resend.emails.send`.
 *
 * ## What never goes in an email
 *
 * Nothing here logs the body. Verification and reset messages contain
 * single-use tokens, and a token in a log file is a token in whatever ships
 * logs off the box (CLAUDE.md §5.8). The console adapter is the one exception
 * and it exists only for development, where the link has to be readable
 * somewhere; it refuses to start in production.
 */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

// The interface is declared once, in `@crm/core`, which the worker shares. This file used to carry a
// second copy that could drift; it now only re-exports, so existing imports keep working (ADR-0073).
export type { EmailMessage, EmailProvider, EmailReceipt } from '@crm/core';

/**
 * Prints to the log instead of sending. Development only.
 *
 * Deliberately loud about which address it would have gone to, because the
 * alternative — a silent no-op — makes "I never got the email" impossible to
 * tell apart from a bug in the flow that produced it.
 */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = createLogger('info', true);

  constructor(@Inject(API_ENV_TOKEN) env: ApiEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'EMAIL_PROVIDER=console cannot be used in production: verification and ' +
          'password-reset links would be written to the log instead of sent.',
      );
    }
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    const context = currentRequestContext();
    this.logger.info(
      { requestId: context?.requestId ?? null, to: message.to, subject: message.subject },
      `[email] ${message.subject} -> ${message.to}\n${message.text}`,
    );
    return Promise.resolve({});
  }
}

/**
 * Keeps sent messages in memory instead of delivering them.
 *
 * For tests and for CI, where the verification and reset flows have to be
 * exercised end to end: the token only ever exists in the email, because the
 * database stores its hash. A test that reached into `verifications` instead
 * would be asserting on our storage rather than on the flow a user takes, and
 * would keep passing if the email were never sent at all.
 *
 * Refuses production for the same reason the console provider does.
 */
@Injectable()
export class MemoryEmailProvider implements EmailProvider {
  private readonly sent: EmailMessage[] = [];

  constructor(@Inject(API_ENV_TOKEN) env: ApiEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error('EMAIL_PROVIDER=memory cannot be used in production: nothing is delivered.');
    }
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    this.sent.push(message);
    // Bounded, so a long-running dev server does not hold every message it
    // has ever produced.
    if (this.sent.length > 200) this.sent.shift();
    return Promise.resolve({});
  }

  messages(): readonly EmailMessage[] {
    return this.sent;
  }

  /** The most recent message to this address, or undefined. */
  lastTo(email: string): EmailMessage | undefined {
    return this.sent.findLast((message) => message.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}
