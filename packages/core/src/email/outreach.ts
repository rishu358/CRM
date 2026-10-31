/**
 * Email sent from a record, and the log of it (ADR-0073).
 *
 * The pure rules, shared by the API (which refuses what is invalid before anything is stored), the
 * worker (which builds the message) and the adapters (which check again before it leaves the
 * building). No database, no clock of its own, no vendor.
 */

import { hasControlCharacter } from './merge-fields.js';

export const EMAIL_SUBJECT_MAX = 200;
/** Plain text only in v1, so there is nothing to sanitize and nothing rendered as markup (ADR-0073). */
export const EMAIL_BODY_MAX = 10_000;
export const EMAIL_FROM_NAME_MAX = 80;
export const EMAIL_FOOTER_MAX = 500;

/**
 * Where a message is in its life. `delivered`, `bounced` and `complained` are allowed by the database
 * but nothing writes them until the provider's own reports are wired in (ADR-0073, PR 3).
 */
export const EMAIL_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'delivered',
  'bounced',
  'complained',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Why a message failed, as a closed list. Never a provider's own text: it can repeat the address.
 */
export const EMAIL_FAILURE_CODES = [
  'rejected',
  'invalid_recipient',
  'provider_unavailable',
  'timeout',
  'outcome_unknown',
  'not_configured',
] as const;
export type EmailFailureCode = (typeof EMAIL_FAILURE_CODES)[number];

/**
 * What the CRM allows, per person and per workspace, per day in the workspace's own time zone.
 *
 * Constants, not configuration: they are a safety limit for shared sending reputation, not a deployment
 * choice, and a plan may later vary them through entitlements. A workspace younger than `rampDays` gets
 * the lower figures, because a brand-new account is where abuse comes from.
 */
export const EMAIL_LIMITS = {
  perUserPerDay: 100,
  perTenantPerDay: 500,
  rampDays: 14,
  rampPerUserPerDay: 20,
  rampPerTenantPerDay: 100,
  /** Sends a person may start in one minute. */
  burstPerMinute: 10,
} as const;

export function emailLimitsFor(tenantAgeInDays: number): { perUser: number; perTenant: number } {
  return tenantAgeInDays < EMAIL_LIMITS.rampDays
    ? { perUser: EMAIL_LIMITS.rampPerUserPerDay, perTenant: EMAIL_LIMITS.rampPerTenantPerDay }
    : { perUser: EMAIL_LIMITS.perUserPerDay, perTenant: EMAIL_LIMITS.perTenantPerDay };
}

/** How many whole days old a workspace is. */
export function tenantAgeDays(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
}

/** The calendar day (`YYYY-MM-DD`) it is in `timeZone` at `now`. */
export function localDay(now: Date, timeZone: string): string {
  // `en-CA` formats as year-month-day, which is the shape the database date wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whole seconds until the next midnight in `timeZone`; at least 1. Used for `Retry-After`. */
export function secondsUntilLocalMidnight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = part('hour') * 3600 + part('minute') * 60 + part('second');
  return Math.max(1, 86_400 - elapsed);
}

/** One line, no control characters, within the limit. */
export function isSingleLine(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !hasControlCharacter(value);
}

export function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * A From display name: letters, digits, spaces and a small set of punctuation. No angle brackets,
 * quotes, at-signs or backslashes, so it can neither close the name nor start an address.
 */
const FROM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\-/]*$/u;

export function isValidFromName(value: string): boolean {
  return isSingleLine(value, EMAIL_FROM_NAME_MAX) && FROM_NAME.test(value);
}

const ADDRESS = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/u;

/** One plain address (`a@b.c`), no display name, no list. Reply-To takes nothing else. */
export function isValidReplyTo(value: string): boolean {
  return isSingleLine(value, 254) && ADDRESS.test(value);
}

export function isValidSubject(value: string): boolean {
  return isSingleLine(value, EMAIL_SUBJECT_MAX);
}

/** A body is text: any characters except NUL, at most `EMAIL_BODY_MAX`. Line breaks are fine here. */
export function isValidBody(value: string): boolean {
  return value.trim().length > 0 && value.length <= EMAIL_BODY_MAX && !value.includes('\u0000');
}

/** A footer is a few lines of text. */
export function isValidFooter(value: string): boolean {
  return value.length <= EMAIL_FOOTER_MAX && !value.includes('\u0000');
}

/** The part of an address after the last `@`, lowercased; null when there is none. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/** The bare address in `Name <a@b.c>` or `a@b.c`, lowercased; null when there is none. */
export function bareAddress(from: string): string | null {
  const match = /<([^<>\s]+)>\s*$/u.exec(from);
  const candidate = (match?.[1] ?? from).trim();
  return addressDomain(candidate) === null ? null : candidate.toLowerCase();
}

/** Our own `Message-ID` for an email: `<id@domain>`. */
export function buildMessageId(id: string, domain: string): string {
  return `<${id}@${domain}>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The plain-text part: the body, then the company's footer under a conventional separator. */
export function renderEmailText(body: string, footer: string | null): string {
  const text = body.replace(/\r\n?/g, '\n').trimEnd();
  return footer === null || footer.trim() === '' ? text : `${text}\n\n-- \n${footer.trim()}`;
}

/**
 * The HTML part, built from the text by escaping it: blank lines become paragraphs, single line
 * breaks become `<br>`. Nothing the sender typed is ever markup, and no link is rewritten or tracked.
 */
export function renderEmailHtml(body: string, footer: string | null): string {
  const lines = (text: string): string => escapeHtml(text).replace(/\n/g, '<br>');
  const blocks = body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/u)
    .map((block) => `<p>${lines(block)}</p>`);
  if (footer !== null && footer.trim() !== '') {
    blocks.push(`<p style="color:#666666;font-size:12px">${lines(footer.trim())}</p>`);
  }
  return blocks.join('\n');
}

/**
 * Consent to email on a contact (`contacts.consent`, `{ email: { status, source, at } }`). Nothing
 * in the CRM writes a status today; `withdrawn` is the one value that stops a send. Anything else,
 * including no record at all, lets it through, and the screen says which (ADR-0073).
 */
export function isEmailConsentWithdrawn(consent: unknown): boolean {
  if (typeof consent !== 'object' || consent === null) return false;
  const email = (consent as Record<string, unknown>)['email'];
  if (typeof email !== 'object' || email === null) return false;
  return (email as Record<string, unknown>)['status'] === 'withdrawn';
}

export function hasEmailConsentRecord(consent: unknown): boolean {
  if (typeof consent !== 'object' || consent === null) return false;
  const email = (consent as Record<string, unknown>)['email'];
  return (
    typeof email === 'object' &&
    email !== null &&
    typeof (email as Record<string, unknown>)['status'] === 'string'
  );
}

/** The kinds of record an email can be sent from. Accounts are not in v1 (ADR-0073). */
export const EMAIL_SOURCE_TYPES = ['contact', 'lead', 'deal'] as const;
export type EmailSourceType = (typeof EMAIL_SOURCE_TYPES)[number];

/**
 * Who an email to a record would go to, as the person asking is allowed to know it.
 *
 * `email` is null both when the record has none and when the field is hidden from the caller: one
 * answer, so it cannot be used to learn that a hidden field has a value (ADR-0073).
 */
export interface EmailRecipient {
  readonly email: string | null;
  readonly name: string | null;
  readonly consent: 'recorded' | 'none' | 'withdrawn';
  /** The parts of the name, each only when the caller may read it (for the merge fields, ADR-0074). */
  readonly firstName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
  /** A contact's company, when the caller may read the link; the record module resolves its name. */
  readonly accountId?: string | null | undefined;
  /** A lead's company name, when the caller may read it. */
  readonly company?: string | null | undefined;
}

/** A person's consent to email, as one of three words. */
export function emailConsentState(consent: unknown): EmailRecipient['consent'] {
  if (isEmailConsentWithdrawn(consent)) return 'withdrawn';
  return hasEmailConsentRecord(consent) ? 'recorded' : 'none';
}
