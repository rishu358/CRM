import type { EmailMessage, EmailProvider, EmailReceipt } from '@crm/core';
import { GuardedOutboundHttp } from './client.js';
import {
  assertSendable,
  formatFromHeader,
  providerMessageIdFrom,
  unsubscribeHeaders,
} from './message.js';
import { OutboundError, type OutboundHttp } from './types.js';

/**
 * Email through Resend's REST API (ADR-0009, ADR-0040, ADR-0041).
 *
 * An adapter, and the only code that knows Resend exists. No SDK: the API is one POST, and a
 * vendor SDK is a dependency to audit and an HTTP client we do not control, so it would sit
 * outside the one guarded door every outbound call goes through (`OutboundHttp`).
 *
 * That door is pinned here to `api.resend.com` over https on 443. The destination is not user
 * input, so SSRF is not the threat; the pin is for the other direction: a mis-set
 * configuration, or a bug that reaches this class with another URL, cannot send the API key
 * (an `Authorization` header) to a host that is not Resend. The client also refuses to carry
 * that header to another origin across a redirect.
 *
 * What it never does: log the message, the recipient or the key. Verification and reset mails
 * carry single-use tokens (CLAUDE.md §5.8), and an error that echoed the request would put one
 * in a log. A failure is reported as a status and Resend's own error name, which is not secret.
 */

const RESEND_HOST = 'api.resend.com';
const RESEND_ENDPOINT = `https://${RESEND_HOST}/emails`;

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null when the request never got an answer. */
    readonly status: number | null,
    /** True when trying again later may work: a rate limit, a server error, a network failure. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface ResendOptions {
  readonly apiKey: string;
  /** `Name <address@domain>` or a bare address: a domain verified with Resend. */
  readonly from: string;
  /** A seam for tests. Production code never passes it; the default is the pinned client. */
  readonly http?: OutboundHttp;
}

/** The pinned, https-only client. Nothing else about the guard is loosened. */
export function pinnedResendClient(): OutboundHttp {
  return new GuardedOutboundHttp({
    urlPolicy: {
      schemes: ['https'],
      ports: [443],
      allowedHosts: [RESEND_HOST],
      maxUrlLength: 256,
    },
    limits: { timeoutMs: 15_000, maxResponseBytes: 64 * 1024 },
    userAgent: 'crm-email/1',
  });
}

export class ResendEmailProvider implements EmailProvider {
  private readonly http: OutboundHttp;

  constructor(private readonly options: ResendOptions) {
    if (options.apiKey.trim() === '') throw new Error('ResendEmailProvider needs an API key');
    // A header value cannot hold a line break, and a key that does is not a key.
    if (/[\r\n\0]/.test(options.apiKey)) throw new Error('The Resend API key is malformed');
    this.http = options.http ?? pinnedResendClient();
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    assertSendable(message);
    const body = JSON.stringify({
      from: formatFromHeader(this.options.from, message.fromName),
      to: [message.to],
      ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(unsubscribeHeaders(message) === undefined
        ? {}
        : { headers: unsubscribeHeaders(message) }),
    });

    let status: number;
    let responseBody: Uint8Array;
    try {
      const response = await this.http.request({
        url: RESEND_ENDPOINT,
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        // Following a redirect with the key attached is never wanted.
        maxRedirects: 0,
      });
      status = response.status;
      responseBody = response.body;
    } catch (error) {
      if (error instanceof OutboundError) {
        // A refusal (`blocked`, `invalid_request`, a redirect) means this build or this configuration
        // is wrong; asking again will not fix it. A slow or unreachable network might get better.
        const retryable =
          error.code === 'timeout' || error.code === 'dns' || error.code === 'network';
        throw new EmailSendError(`Email was not sent: ${error.code}`, null, retryable);
      }
      throw error;
    }

    if (status >= 200 && status < 300) {
      const providerMessageId = providerMessageIdFrom(responseBody, 'id');
      return providerMessageId === undefined ? {} : { providerMessageId };
    }

    // 408, 409 (idempotency in flight), 429 and any 5xx are worth another try; the rest are not.
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    throw new EmailSendError(
      `Email was not sent: Resend answered ${String(status)}${describe(responseBody)}`,
      status,
      retryable,
    );
  }
}

/** Resend's error name, if the body has one: `validation_error`, `rate_limit_exceeded`, … */
function describe(body: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const name = parsed.name;
      if (typeof name === 'string' && /^[a-z_]{1,64}$/.test(name)) return ` (${name})`;
    }
  } catch {
    // Not JSON: say nothing about it. The body could be anything, including an echo of the request.
  }
  return '';
}

export function createResendEmailProvider(options: Omit<ResendOptions, 'http'>): EmailProvider {
  return new ResendEmailProvider(options);
}
