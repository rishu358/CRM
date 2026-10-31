import { bareAddress, isValidFromName, isValidReplyTo, type EmailMessage } from '@crm/core';
import { EmailSendError } from './resend.js';

/**
 * What every email adapter checks before a message leaves the building (ADR-0073).
 *
 * The API has already validated the sender name, the reply address and the subject, so these checks
 * are the second line of defence: a bug, a new caller or a hand-written job must not be able to put a
 * line break into a header, or send as another address, through any adapter. A refusal is not
 * retryable and says only that the request was invalid, never which value was wrong.
 */

const HEADER_UNSAFE = /[\r\n\0]/;
const MESSAGE_ID = /^<[^<>\s@]{1,200}@[^<>\s@]{1,200}>$/;
/** One address, in angle brackets in a header: no space, bracket or quote can end it early. */
const UNSUBSCRIBE_URL = /^https?:\/\/[^\s<>"\\]{1,500}$/;

export function assertSendable(message: EmailMessage): void {
  const invalid =
    HEADER_UNSAFE.test(message.to) ||
    HEADER_UNSAFE.test(message.subject) ||
    (message.fromName !== undefined && !isValidFromName(message.fromName)) ||
    (message.replyTo !== undefined && !isValidReplyTo(message.replyTo)) ||
    (message.messageId !== undefined && !MESSAGE_ID.test(message.messageId)) ||
    (message.unsubscribeUrl !== undefined &&
      (HEADER_UNSAFE.test(message.unsubscribeUrl) ||
        !UNSUBSCRIBE_URL.test(message.unsubscribeUrl)));
  if (invalid) throw new EmailSendError('Email was not sent: invalid_request', null, false);
}

/**
 * The headers that let a mail program offer its own "unsubscribe" button (RFC 8058): the address to post to,
 * and the statement that one post is enough. None when the message carries no address. The same two for every
 * adapter, so what each one adds to its request is a mapping, not a decision.
 */
export function unsubscribeHeaders(message: EmailMessage): Record<string, string> | undefined {
  if (message.unsubscribeUrl === undefined) return undefined;
  return {
    'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * The `From` header: the configured address, with this message's display name when it has one.
 *
 * Only the **name** is per message. The address is always the one the adapter was built with, so
 * nothing a caller passes can change the domain mail is sent as. An ASCII name is quoted (it may hold
 * a comma or a full stop, which would otherwise end the name); anything else is sent as RFC 2047
 * encoded words, in pieces short enough for the 75-character limit on each.
 */
export function formatFromHeader(configuredFrom: string, fromName: string | undefined): string {
  if (fromName === undefined) return configuredFrom;
  const address = bareAddress(configuredFrom);
  if (address === null) return configuredFrom;
  const ascii = /^[ -~]*$/.test(fromName);
  return `${ascii ? `"${fromName}"` : encodeWords(fromName)} <${address}>`;
}

function encodeWords(name: string): string {
  const words: string[] = [];
  let piece: number[] = [];
  const flush = (): void => {
    if (piece.length === 0) return;
    words.push(`=?UTF-8?B?${Buffer.from(piece).toString('base64')}?=`);
    piece = [];
  };
  for (const character of name) {
    const bytes = [...Buffer.from(character, 'utf8')];
    // 45 bytes encode to 60 characters, which with the 12 of wrapper stays under 75.
    if (piece.length + bytes.length > 45) flush();
    piece.push(...bytes);
  }
  flush();
  return words.join(' ');
}

/** A provider's id for a message, if the response body has one in a plain, short shape. */
export function providerMessageIdFrom(body: Uint8Array, key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed === 'object' && parsed !== null && key in parsed) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string' && /^[A-Za-z0-9._@-]{1,128}$/.test(value)) return value;
    }
  } catch {
    // Not JSON, or not what we expect: no id is better than a made-up one.
  }
  return undefined;
}
