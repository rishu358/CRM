/**
 * The plain WhatsApp chat link (Phase 2, first piece).
 *
 * Nothing here talks to WhatsApp. A chat link is an address the user's own
 * device opens in the WhatsApp app or WhatsApp Web; our servers send nothing,
 * log nothing and hold no Meta account. The Business API is a separate, later
 * piece with its own provider adapter.
 *
 * This file is the only place that names the WhatsApp host and the only place
 * that turns a phone number into an address. That is deliberate: the number is
 * text a person typed or an import carried in, so everything that reaches an
 * `href` is decided here, once, and tested against hostile input.
 *
 * The host is a constant, not configuration (ADR-0061). It is the vendor's
 * published deep-link address, it is the same on every deployment, and making it
 * configurable would let a misconfiguration send people's phone numbers to
 * whatever host was configured.
 */

/** The one place the WhatsApp chat host is named. */
const WHATSAPP_CHAT_ORIGIN = 'https://wa.me';

/**
 * Strict E.164 for a chat link: a plus sign, then 8 to 15 digits, the first not
 * zero. `[0-9]` rather than `\d` so no reader has to wonder about other scripts'
 * digits, and no `m` flag so `$` can only mean the end of the string.
 */
const CHAT_NUMBER = /^\+[1-9][0-9]{7,14}$/;

/** The longest first message put in a link, counted in characters a person sees. */
export const WHATSAPP_MAX_TEXT_LENGTH = 500;

/** Whether this is a number a chat link can be built for. Whitespace makes it invalid. */
export function isWhatsAppNumber(value: unknown): value is string {
  return typeof value === 'string' && CHAT_NUMBER.test(value);
}

/*
 * Characters that change how text looks or flows without being visible: the
 * zero-width characters, the bidirectional controls and the byte-order mark.
 * They are how a message is made to read differently from what it says, so a
 * first message never carries them. Plain right-to-left letters need none.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Control characters other than a line feed. A carriage return becomes a line feed first.
// eslint-disable-next-line no-control-regex -- the point of the pattern is to match them
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
// A half of a surrogate pair on its own would make encodeURIComponent throw.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cleanText(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(LONE_SURROGATE, '�')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .trim();
  // Counted by code point so an emoji is one character, and never cut in half.
  return Array.from(cleaned).slice(0, WHATSAPP_MAX_TEXT_LENGTH).join('').trim();
}

/** `encodeURIComponent` leaves `! ' ( ) *` alone; they are encoded too so the query has one shape. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The address that opens a WhatsApp chat with `number`, with `text` typed in
 * ready to send when it is given.
 *
 * Returns null for anything that is not strict E.164 (see `isWhatsAppNumber`).
 * The only characters that can appear after the host are the digits of the
 * number and a percent-encoded query, so no scheme, host or path of the
 * caller's choosing can result.
 *
 * `text` is optional. It is cleaned (invisible and control characters removed,
 * line endings made `\n`), capped at `WHATSAPP_MAX_TEXT_LENGTH` characters and
 * percent-encoded. Text that is empty once cleaned adds no query at all.
 */
export function buildWhatsAppLink(number: unknown, text?: unknown): string | null {
  if (!isWhatsAppNumber(number)) return null;
  const link = `${WHATSAPP_CHAT_ORIGIN}/${number.slice(1)}`;
  if (typeof text !== 'string') return link;
  const cleaned = cleanText(text);
  return cleaned.length === 0 ? link : `${link}?text=${encode(cleaned)}`;
}

/** Which of a record's numbers a chat will use. */
export type WhatsAppSource = 'whatsapp' | 'phone';

export type WhatsAppTarget =
  | {
      readonly status: 'link';
      readonly source: WhatsAppSource;
      readonly number: string;
      readonly href: string;
    }
  | { readonly status: 'invalid'; readonly source: WhatsAppSource; readonly number: string };

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Decides which number a record's chat button uses, or that there is none.
 *
 * The WhatsApp number wins; the phone number is the fallback only when there is
 * no WhatsApp number at all. A WhatsApp number that is there but malformed is
 * reported as `invalid` rather than quietly swapped for the phone: the person
 * should fix the number they entered, not chat with one they did not choose.
 * Returns null when the record has neither, and the button is not shown.
 */
export function whatsAppTarget(record: {
  readonly whatsapp?: string | null | undefined;
  readonly phone?: string | null | undefined;
}): WhatsAppTarget | null {
  const source: WhatsAppSource | null = present(record.whatsapp)
    ? 'whatsapp'
    : present(record.phone)
      ? 'phone'
      : null;
  if (source === null) return null;
  const number = (source === 'whatsapp' ? record.whatsapp : record.phone) as string;
  const href = buildWhatsAppLink(number);
  return href === null
    ? { status: 'invalid', source, number }
    : { status: 'link', source, number, href };
}
