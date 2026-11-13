/**
 * Inbound replies (ADR-0077): the address every sent email carries for answers to reach us, what a received
 * message is shaped into before it is stored, and the limits that keep a stranger's mail from filling a
 * company's log.
 *
 * Pure and safe for the browser (no `node:crypto`): the signing lives in `reply-address-token.ts`, which is a
 * subpath of its own. Nothing here talks to a provider; the one interface that does is `InboundEmailProvider`.
 */

import { hasControlCharacter } from './merge-fields.js';
import { EMAIL_BODY_MAX, normalizeSingleLine } from './outreach.js';

/**
 * The part of a reply address before the `@`: `r.<32 hex: the email's id without hyphens>.<26 base32>`, 61
 * characters. A mail address's local part may be 64 at most, and mail systems may change its case, so it is short
 * and lower-case only; the 26 characters are 128 bits of a signature of the id (`reply-address-token.ts`).
 */
export const REPLY_LOCAL_PATTERN = /^r\.[0-9a-f]{32}\.[a-z2-7]{26}$/;

/** A whole reply address on some domain: the local part above, then a plain lower-case host name. */
export const REPLY_ADDRESS_PATTERN =
  /^r\.[0-9a-f]{32}\.[a-z2-7]{26}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export function isReplyAddressShape(value: unknown): value is string {
  return typeof value === 'string' && REPLY_ADDRESS_PATTERN.test(value);
}

/** The email id (with hyphens) inside a local part of the right shape. Proof of nothing until it is verified. */
export function emailIdFromReplyLocal(local: string): string | null {
  if (!REPLY_LOCAL_PATTERN.test(local)) return null;
  const hex = local.slice(2, 34);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function replyAddress(token: string, inboundDomain: string): string {
  return `${token}@${inboundDomain}`;
}

/**
 * The token and the email id in an address that is on our inbound domain and has the right shape, or null.
 * Case is folded first: a mail system that lower-cases an address must not make it unrecognisable.
 */
export function parseReplyAddress(
  address: string,
  inboundDomain: string,
): { token: string; emailId: string } | null {
  const lowered = address.trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at < 1 || lowered.slice(at + 1) !== inboundDomain.toLowerCase()) return null;
  const token = lowered.slice(0, at);
  const emailId = emailIdFromReplyLocal(token);
  return emailId === null ? null : { token, emailId };
}

/**
 * The inbound domain as configured, lower-cased, or null when it is not a plain host name with at least one dot.
 * A typo must not quietly switch the feature on at a wrong address, so a caller that gets null for a non-empty
 * value refuses to start.
 */
export function normalizeInboundDomain(value: string | undefined): string | null {
  if (value === undefined) return null;
  const domain = value.trim().toLowerCase();
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? domain
    : null;
}

/**
 * The limits on what a stranger can put on a company's log through a reply address. Constants, not
 * configuration; the numbers are a proposal the owner approved with the plan, not a standard that was verified.
 */
export const EMAIL_REPLY_LIMITS = {
  /** Replies filed under one sent email. */
  perEmail: 20,
  /** Replies filed for one company in a day. */
  perCompanyPerDay: 500,
  /** The most the receiving adapter will read of one received message, in bytes. */
  fetchMaxBytes: 1_048_576,
} as const;

/** What a message with no plain-text part is stored as, so the row says so instead of looking empty. */
export const NO_PLAIN_TEXT = '(this message had no plain-text part)';

/** A received message as an adapter reports it, with nothing of the provider's own field names in it. */
export interface ReceivedEmail {
  /** The sender as **claimed**: a bare address. */
  readonly fromAddress: string;
  /** The display name from the `From` header, when there is one. */
  readonly fromName: string | null;
  readonly subject: string;
  /** The plain-text part, or null when the message has none. HTML is never taken. */
  readonly text: string | null;
  /** The sender's own `Message-ID`, when there is one. */
  readonly messageId: string | null;
  readonly attachmentCount: number;
}

export interface InboundEmailProvider {
  /** Retrieve what a received email says, by the provider's id for it. */
  retrieve(providerEmailId: string): Promise<ReceivedEmail>;
}

/** What is stored for a received message: shortened to fit the log's columns, and never HTML. */
export interface ShapedReply {
  readonly fromName: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  /** True when the body was cut to the log's limit. */
  readonly bodyShortened: boolean;
}

const ADDRESS_SHAPE = /^[^\s@<>"',;()[\]\\]{1,64}@[^\s@<>"',;()[\]\\]{1,253}$/;

/** Keep what can be shown as text: line breaks and tabs, and nothing else below a space. */
function stripControl(text: string): string {
  let out = '';
  for (const character of text.replace(/\r\n?/g, '\n')) {
    const code = character.charCodeAt(0);
    if (code >= 32 || code === 10 || code === 9) out += character;
  }
  return out;
}

/**
 * Turn a received message into what the log can hold, or null when it has no usable sender. The sender is
 * lower-cased and must look like one plain address; the name is cut to 80 characters (the address stands in
 * for it when there is none); the subject to 200 on one line; the body to the same 10,000 characters an
 * outgoing body may have, with a flag when it was cut. A message with no plain-text part says so.
 */
export function shapeReceivedEmail(received: ReceivedEmail): ShapedReply | null {
  const address = received.fromAddress.trim().toLowerCase();
  if (address.length > 254 || hasControlCharacter(address) || !ADDRESS_SHAPE.test(address)) {
    return null;
  }
  const name = normalizeSingleLine(stripControl(received.fromName ?? ''))
    .slice(0, 80)
    .trim();
  const subject = normalizeSingleLine(stripControl(received.subject)).slice(0, 200).trim();

  const text = received.text === null ? '' : stripControl(received.text).trim();
  const body = text === '' ? NO_PLAIN_TEXT : text;
  const bodyShortened = body.length > EMAIL_BODY_MAX;
  return {
    fromName: name === '' ? address.slice(0, 80) : name,
    fromAddress: address,
    subject: subject === '' ? '(no subject)' : subject,
    body: bodyShortened ? body.slice(0, EMAIL_BODY_MAX) : body,
    bodyShortened,
  };
}
