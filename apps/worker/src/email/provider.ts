import type { EmailMessage, EmailProvider, EmailReceipt } from '@crm/core';
import { createRemoteEmailProvider, EmailSendError } from '@crm/outbound';
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

  async send(message: EmailMessage): Promise<EmailReceipt> {
    this.logger.info(
      { to: message.to, subject: message.subject },
      `[email] ${message.subject} -> ${message.to}\n${message.text}`,
    );
    return Promise.resolve({});
  }
}

/** Keeps messages in memory instead of delivering them. Tests and CI only. */
export class MemoryEmailProvider implements EmailProvider {
  private readonly sent: EmailMessage[] = [];
  private readonly failures: EmailSendError[] = [];
  private counter = 0;

  async send(message: EmailMessage): Promise<EmailReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sent.push(message);
    // Bounded, so a long-running dev worker does not hold every message it
    // has ever produced.
    if (this.sent.length > 200) this.sent.shift();
    this.counter += 1;
    return Promise.resolve({ providerMessageId: `memory-${String(this.counter)}` });
  }

  /**
   * Make the next send fail, as a real adapter would (tests only). `retryable` is the adapter's own
   * flag: a timeout or a 5xx is retryable, a refusal of the address is not (ADR-0073).
   */
  failNext(options: { retryable: boolean; status?: number | null }): void {
    this.failures.push(
      new EmailSendError('Email was not sent: test', options.status ?? null, options.retryable),
    );
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

export interface EmailProviderConfig {
  readonly kind: 'console' | 'memory' | 'resend' | 'ses' | 'smtp';
  readonly nodeEnv: string;
  readonly logger: Logger;
  readonly resendApiKey?: string | undefined;
  readonly sesRegion?: string | undefined;
  readonly sesAccessKeyId?: string | undefined;
  readonly sesSecretAccessKey?: string | undefined;
  readonly sesConfigurationSet?: string | undefined;
  readonly smtpHost?: string | undefined;
  readonly smtpPort: number;
  readonly smtpSecurity: 'starttls' | 'tls' | 'none';
  readonly smtpUser?: string | undefined;
  readonly smtpPassword?: string | undefined;
  readonly from: string;
}

export function createEmailProvider(config: EmailProviderConfig): EmailProvider {
  const { kind, nodeEnv, logger } = config;
  if (kind === 'resend') {
    return createRemoteEmailProvider({
      kind: 'resend',
      from: config.from,
      resendApiKey: config.resendApiKey,
    });
  }
  if (kind === 'ses') {
    return createRemoteEmailProvider({
      kind: 'ses',
      from: config.from,
      sesRegion: config.sesRegion,
      sesAccessKeyId: config.sesAccessKeyId,
      sesSecretAccessKey: config.sesSecretAccessKey,
      sesConfigurationSet: config.sesConfigurationSet,
    });
  }
  if (kind === 'smtp') {
    return createRemoteEmailProvider({
      kind: 'smtp',
      from: config.from,
      nodeEnv,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecurity: config.smtpSecurity,
      smtpUser: config.smtpUser,
      smtpPassword: config.smtpPassword,
    });
  }
  if (nodeEnv === 'production') {
    throw new Error(
      `EMAIL_PROVIDER=${kind} cannot be used in production: digests would be ` +
        'written to the log or discarded instead of sent.',
    );
  }
  return kind === 'memory' ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger);
}
