import type { EmailMessage, EmailProvider } from '@crm/core';
import type { Logger } from 'pino';

/**
 * Outbound email from the worker, behind the shared interface (ADR-0009).
 *
 * The worker sends the activity digest (ADR-0025), so it needs a provider of
 * its own: it is a separate process from the API and shares none of its DI
 * container. The *interface* is shared — it lives in `@crm/core` — so the two
 * cannot drift, and no vendor SDK is imported outside an adapter.
 *
 * Both implementations here refuse to run in production for the same reason
 * the API's do: one of them prints mail to the log and the other throws it
 * away, and discovering that in production means digests that silently never
 * arrived.
 */
export class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject },
      `[email] ${message.subject} -> ${message.to}\n${message.text}`,
    );
    return Promise.resolve();
  }
}

/** Keeps messages in memory instead of delivering them. Tests and CI only. */
export class MemoryEmailProvider implements EmailProvider {
  private readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    // Bounded, so a long-running dev worker does not hold every message it
    // has ever produced.
    if (this.sent.length > 200) this.sent.shift();
    return Promise.resolve();
  }

  messages(): readonly EmailMessage[] {
    return this.sent;
  }

  lastTo(email: string): EmailMessage | undefined {
    return this.sent.findLast((message) => message.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export function createEmailProvider(
  kind: 'console' | 'memory',
  nodeEnv: string,
  logger: Logger,
): EmailProvider {
  if (nodeEnv === 'production') {
    throw new Error(
      `EMAIL_PROVIDER=${kind} cannot be used in production: digests would be ` +
        'written to the log or discarded instead of sent.',
    );
  }
  return kind === 'memory' ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger);
}
