import { bareAddress, type EmailMessage, type EmailProvider, type EmailReceipt } from '@crm/core';
import { createTransport, type Transporter } from 'nodemailer';
import { assertSendable, unsubscribeHeaders } from './message.js';
import { EmailSendError } from './resend.js';

/**
 * Email through an SMTP server (ADR-0009, ADR-0048): a company's own mail server, or any relay.
 *
 * An adapter, and the only code that imports a mail library. SMTP is a protocol rather than one
 * request (STARTTLS, authentication, dot-stuffing, MIME, the encoding of non-ASCII headers), so this
 * is the one provider that uses a library (`nodemailer`) instead of the guarded HTTP client.
 *
 * **The server is the operator's choice, never a user's.** It comes from configuration, not from any
 * request, which is why it does not go through the SSRF guard that refuses private addresses: an
 * internal relay on a private network is a normal, wanted setup.
 *
 * ## Transport security
 *
 * Plain text is not offered in production. `tls` connects over TLS from the first byte (port 465);
 * `starttls` connects in clear and **requires** the upgrade, so a server that does not offer it, or a
 * downgrade by someone in the middle, fails instead of sending in clear. Certificates are verified,
 * and TLS 1.2 is the floor. `none` exists for a local development inbox only and is refused in
 * production (the configuration check and this constructor).
 *
 * ## What it never does
 *
 * Log the message, the recipient or the credentials. Verification and reset mails carry single-use
 * tokens (CLAUDE.md §5.8). A server's own error text often repeats the address it refused, so a
 * failure is reported as a code and an SMTP status, never as the server's words. The library is told
 * not to read local files or fetch URLs named in a message.
 */

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /** `Name <address@domain>` or a bare address. */
  readonly from: string;
  /** Production refuses `security: 'none'`. */
  readonly nodeEnv: string;
  /** A seam for tests. Production code never passes it. */
  readonly transport?: Pick<Transporter, 'sendMail'>;
}

/** CR, LF and NUL have no place in an address or a subject: they are how headers get injected. */
const HEADER_UNSAFE = /[\r\n\0]/;

/** Library error codes that mean the network, not the message: asking again later may work. */
const RETRYABLE_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Pick<Transporter, 'sendMail'>;

  constructor(private readonly options: SmtpOptions) {
    if (options.host.trim() === '' || /[\s/]/.test(options.host)) {
      throw new Error('SMTP_HOST must be a host name or address');
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new Error('SMTP_PORT must be a port number');
    }
    if (options.security === 'none' && options.nodeEnv === 'production') {
      throw new Error(
        'SMTP_SECURITY=none cannot be used in production: mail and credentials would cross the network in clear.',
      );
    }
    if ((options.user === undefined) !== (options.password === undefined)) {
      throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
    }
    if (HEADER_UNSAFE.test(options.from)) throw new Error('EMAIL_FROM is malformed');
    for (const value of [options.user, options.password]) {
      if (value !== undefined && /[\r\n\0]/.test(value)) {
        throw new Error('The SMTP credentials are malformed');
      }
    }

    this.transport =
      options.transport ??
      createTransport({
        host: options.host,
        port: options.port,
        // `secure` is TLS from the first byte; `requireTLS` makes the STARTTLS upgrade mandatory.
        secure: options.security === 'tls',
        requireTLS: options.security === 'starttls',
        ignoreTLS: options.security === 'none',
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        ...(options.user === undefined
          ? {}
          : { auth: { user: options.user, pass: options.password as string } }),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    // Defence in depth: the library encodes headers, and these values are ours, but a line break in
    // an address or subject is never legitimate, so it is refused rather than relied on to be safe.
    assertSendable(message);

    // Only the display name is per message; the address is the one this provider was built with.
    const address = bareAddress(this.options.from);
    const from =
      message.fromName === undefined || address === null
        ? this.options.from
        : { name: message.fromName, address };

    try {
      const result: unknown = await this.transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
        ...(unsubscribeHeaders(message) === undefined
          ? {}
          : { headers: unsubscribeHeaders(message) }),
      });
      const id = field(result, 'messageId');
      return typeof id === 'string' && id.length <= 256 ? { providerMessageId: id } : {};
    } catch (error) {
      throw failure(error);
    }
  }
}

/** A failure as a code and an SMTP status: never the server's text, which may repeat the address. */
function failure(error: unknown): EmailSendError {
  const code = field(error, 'code');
  const responseCode = field(error, 'responseCode');
  const status = typeof responseCode === 'number' ? responseCode : null;
  const name = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : 'UNKNOWN';

  // A temporary refusal (4xx) or a network failure is worth another try; a permanent one (5xx),
  // a bad login or a bad envelope is not.
  const retryable =
    (status !== null && status >= 400 && status < 500) ||
    (status === null && RETRYABLE_CODES.has(name));

  return new EmailSendError(
    `Email was not sent: SMTP ${name}${status === null ? '' : ` ${String(status)}`}`,
    status,
    retryable,
  );
}

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

export function createSmtpEmailProvider(options: Omit<SmtpOptions, 'transport'>): EmailProvider {
  return new SmtpEmailProvider(options);
}
