import type { EmailMessage, EmailProvider, EmailReceipt } from '@crm/core';
import { GuardedOutboundHttp } from './client.js';
import { assertSendable, formatFromHeader, providerMessageIdFrom } from './message.js';
import { EmailSendError } from './resend.js';
import { signV4 } from './sigv4.js';
import { OutboundError, type OutboundHttp } from './types.js';

/**
 * Email through Amazon SES's v2 REST API (ADR-0009, ADR-0048).
 *
 * An adapter, and the only code that knows SES exists. No SDK, for the reason the Resend adapter has
 * none: the API is one signed POST, and an SDK is a dependency to audit and an HTTP client outside
 * the one guarded door every outbound call goes through (`OutboundHttp`). The request is signed with
 * Signature Version 4 (`sigv4.ts`).
 *
 * That door is pinned to `email.<region>.amazonaws.com` over https on 443. The region is validated
 * against the shape of an AWS region name before it becomes part of a host name, so a mis-set value
 * cannot point the signed request, and the secret it is signed with, at another host. Redirects are
 * never followed.
 *
 * What it never does: log the message, the recipient or either key. Verification and reset mails carry
 * single-use tokens (CLAUDE.md §5.8). A failure is a status and SES's own error type, which is not
 * secret.
 *
 * Not supported: the China regions (`amazonaws.com.cn`) and temporary credentials with a session token.
 */

/** `ap-south-1`, `us-gov-west-1`, `eu-central-2`: lowercase words and a trailing digit. */
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;

export function sesHost(region: string): string {
  if (!REGION.test(region)) throw new Error('SES_REGION is not an AWS region name');
  return `email.${region}.amazonaws.com`;
}

export interface SesOptions {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `Name <address@domain>` or a bare address: an identity verified with SES. */
  readonly from: string;
  /** Optional: a configuration set, for delivery events and sending limits. */
  readonly configurationSet?: string | undefined;
  /** A seam for tests. Production code never passes it; the default is the pinned client. */
  readonly http?: OutboundHttp;
  /** A seam for tests: the instant the request is signed at. */
  readonly now?: () => Date;
}

/** The pinned, https-only client for one SES region. */
export function pinnedSesClient(region: string): OutboundHttp {
  return new GuardedOutboundHttp({
    urlPolicy: {
      schemes: ['https'],
      ports: [443],
      allowedHosts: [sesHost(region)],
      maxUrlLength: 256,
    },
    limits: { timeoutMs: 15_000, maxResponseBytes: 64 * 1024 },
    userAgent: 'crm-email/1',
  });
}

const PATH = '/v2/email/outbound-emails';

export class SesEmailProvider implements EmailProvider {
  private readonly http: OutboundHttp;
  private readonly host: string;

  constructor(private readonly options: SesOptions) {
    this.host = sesHost(options.region);
    for (const [name, value] of [
      ['access key id', options.accessKeyId],
      ['secret access key', options.secretAccessKey],
    ] as const) {
      if (value.trim() === '') throw new Error(`SesEmailProvider needs the ${name}`);
      // A header value cannot hold a line break, and a key that does is not a key.
      if (/[\r\n\0\s]/.test(value)) throw new Error(`The SES ${name} is malformed`);
    }
    this.http = options.http ?? pinnedSesClient(options.region);
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    assertSendable(message);
    const body = JSON.stringify({
      FromEmailAddress: formatFromHeader(this.options.from, message.fromName),
      Destination: { ToAddresses: [message.to] },
      ...(message.replyTo === undefined ? {} : { ReplyToAddresses: [message.replyTo] }),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            ...(message.html === undefined
              ? {}
              : { Html: { Data: message.html, Charset: 'UTF-8' } }),
          },
        },
      },
      ...(this.options.configurationSet === undefined || this.options.configurationSet === ''
        ? {}
        : { ConfigurationSetName: this.options.configurationSet }),
    });

    const { headers } = signV4({
      method: 'POST',
      host: this.host,
      path: PATH,
      region: this.options.region,
      service: 'ses',
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      headers: { 'content-type': 'application/json' },
      body,
      now: (this.options.now ?? (() => new Date()))(),
    });

    let status: number;
    let errorType: string | undefined;
    let responseBody: Uint8Array;
    try {
      const response = await this.http.request({
        url: `https://${this.host}${PATH}`,
        method: 'POST',
        headers: { ...headers, accept: 'application/json' },
        body,
        // Following a redirect with a signed request is never wanted.
        maxRedirects: 0,
      });
      status = response.status;
      responseBody = response.body;
      errorType = response.headers['x-amzn-errortype'];
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
      const providerMessageId = providerMessageIdFrom(responseBody, 'MessageId');
      return providerMessageId === undefined ? {} : { providerMessageId };
    }

    // 408, 429 and any 5xx are worth another try; the rest (a rejected message, an unverified
    // identity, a bad signature) are not.
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new EmailSendError(
      `Email was not sent: SES answered ${String(status)}${describe(errorType)}`,
      status,
      retryable,
    );
  }
}

/**
 * SES's error type, from the header it sets: `MessageRejected`, `TooManyRequestsException`,
 * `AccessDeniedException`. Only a plain name is repeated; the header could in principle be anything.
 * Some carry a `:` suffix with a documentation URL, which is dropped.
 */
function describe(errorType: string | undefined): string {
  if (errorType === undefined) return '';
  const name = errorType.split(':')[0] ?? '';
  return /^[A-Za-z]{1,64}$/.test(name) ? ` (${name})` : '';
}

export function createSesEmailProvider(options: Omit<SesOptions, 'http' | 'now'>): EmailProvider {
  return new SesEmailProvider(options);
}
