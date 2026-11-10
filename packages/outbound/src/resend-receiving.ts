import { EMAIL_REPLY_LIMITS, type InboundEmailProvider, type ReceivedEmail } from '@crm/core';
import { pinnedResendClient } from './resend.js';
import { OutboundError, type OutboundHttp } from './types.js';

/**
 * Fetching what a received email says, from Resend (ADR-0077), in the one place that knows Resend's field names
 * for it.
 *
 * Resend's webhook for a received email carries metadata only, never the body, so the worker asks for the
 * message by Resend's id: `GET /emails/receiving/{id}` (the API reference, read 2026-11-10; **nothing here has
 * been run against a real account**). It goes through the same pinned, https-only client as sending, to
 * `api.resend.com` and nowhere else: nothing in a message can choose an address to fetch, and a `download_url`
 * or a `raw` link in the answer is never followed.
 *
 * What it takes from the answer: the sender (bare address, and the display name from the `From` header when
 * there is one), the subject, the **plain-text** part, the sender's own `Message-ID` and how many attachments
 * there were. It never takes the HTML, the other headers or an attachment. Nothing is logged: not the id, the
 * address, the subject or the body.
 */

export class EmailFetchError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null when the request never got an answer. */
    readonly status: number | null,
    /** True when trying again later may work: not there yet, a rate limit, a server error, a network failure. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailFetchError';
  }
}

export interface ResendReceivingOptions {
  readonly apiKey: string;
  /** A seam for tests. Production code never passes it; the default is the pinned client. */
  readonly http?: OutboundHttp;
}

const ENDPOINT = 'https://api.resend.com/emails/receiving/';
const ID = /^[A-Za-z0-9._@-]{1,128}$/;

export class ResendReceivingProvider implements InboundEmailProvider {
  private readonly http: OutboundHttp;

  constructor(private readonly options: ResendReceivingOptions) {
    if (options.apiKey.trim() === '') throw new Error('ResendReceivingProvider needs an API key');
    // A header value cannot hold a line break, and a key that does is not a key.
    if (/[\r\n\0]/.test(options.apiKey)) throw new Error('The Resend API key is malformed');
    this.http = options.http ?? pinnedResendClient();
  }

  async retrieve(providerEmailId: string): Promise<ReceivedEmail> {
    if (!ID.test(providerEmailId)) {
      throw new EmailFetchError('Received email was not fetched: invalid_request', null, false);
    }

    let status: number;
    let body: Uint8Array;
    try {
      const response = await this.http.request({
        // `cid` keeps inline images out of the HTML part: the HTML is never used, and a message with large inline
        // images would otherwise come back as a very large answer.
        url: `${ENDPOINT}${encodeURIComponent(providerEmailId)}?html_format=cid`,
        method: 'GET',
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: 'application/json' },
        maxRedirects: 0,
        maxResponseBytes: EMAIL_REPLY_LIMITS.fetchMaxBytes,
      });
      status = response.status;
      body = response.body;
    } catch (error) {
      if (error instanceof OutboundError) {
        // A refusal (`blocked`, `invalid_request`, a redirect, too large) will not get better by asking again; a
        // slow or unreachable network might.
        const retryable =
          error.code === 'timeout' || error.code === 'dns' || error.code === 'network';
        throw new EmailFetchError(`Received email was not fetched: ${error.code}`, null, retryable);
      }
      throw error;
    }

    if (status >= 200 && status < 300) return parseReceived(body);

    // 404 may only mean the message is not readable yet (the documentation does not say how soon it is), so it is
    // tried again like a rate limit or a server error; the relay's own limit on attempts ends it.
    const retryable = status === 404 || status === 408 || status === 429 || status >= 500;
    throw new EmailFetchError(
      `Received email was not fetched: Resend answered ${String(status)}`,
      status,
      retryable,
    );
  }
}

const BARE_ADDRESS = /^[^\s<>"]+@[^\s<>"]+$/;

/** `Name <a@b>`, `"Name" <a@b>` or a bare address, as a name and an address. */
export function parseFromHeader(value: string): { name: string | null; address: string } | null {
  const text = value.trim();
  const open = text.lastIndexOf('<');
  const close = text.lastIndexOf('>');
  if (open >= 0 && close > open) {
    const address = text.slice(open + 1, close).trim();
    if (!BARE_ADDRESS.test(address)) return null;
    const name = text
      .slice(0, open)
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .trim();
    return { name: name === '' ? null : name, address };
  }
  return BARE_ADDRESS.test(text) ? { name: null, address: text } : null;
}

function parseReceived(body: Uint8Array): ReceivedEmail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new EmailFetchError('Received email was not fetched: unreadable_answer', null, false);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new EmailFetchError('Received email was not fetched: unreadable_answer', null, false);
  }
  const fields = parsed as Record<string, unknown>;

  // The sender: the `from` field, and the display name from the `From` header, which the documentation says is
  // kept in `headers.from`.
  const headers = typeof fields['headers'] === 'object' ? fields['headers'] : null;
  const headerFrom =
    headers !== null && typeof (headers as Record<string, unknown>)['from'] === 'string'
      ? parseFromHeader((headers as Record<string, string>)['from'] as string)
      : null;
  const field = typeof fields['from'] === 'string' ? parseFromHeader(fields['from']) : null;
  const sender = field ?? headerFrom;
  if (sender === null) {
    throw new EmailFetchError('Received email was not fetched: no_sender', null, false);
  }

  const attachments = Array.isArray(fields['attachments']) ? fields['attachments'].length : 0;
  const messageId = fields['message_id'];
  return {
    fromAddress: sender.address,
    fromName: sender.name ?? headerFrom?.name ?? null,
    subject: typeof fields['subject'] === 'string' ? fields['subject'] : '',
    text: typeof fields['text'] === 'string' ? fields['text'] : null,
    messageId: typeof messageId === 'string' ? messageId : null,
    attachmentCount: Math.min(attachments, 1000),
  };
}

export function createResendInboundEmailProvider(
  options: ResendReceivingOptions,
): InboundEmailProvider {
  return new ResendReceivingProvider(options);
}
