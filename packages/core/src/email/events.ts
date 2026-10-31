/**
 * What the mail service tells us happened to an email, and what we do about it (ADR-0075).
 *
 * Pure rules shared by the adapter that reads a provider's event (which turns it into the normalized shape
 * below, so no vendor's field names leave the adapter), the public door that receives it, and the worker
 * that applies it. No database, no clock of its own, no vendor.
 */

import type { EmailStatus } from './outreach.js';

/**
 * The only kinds of event we act on. Anything else a provider sends is ignored, not stored. `unsubscribed` is
 * not a provider's: it is the person's own click on the link in the email (ADR-0076), recorded the same way.
 */
export const EMAIL_EVENT_TYPES = ['delivered', 'bounced', 'complained', 'unsubscribed'] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

/**
 * Why a message bounced, as a closed list. Never the provider's own words: they can repeat the address
 * and the server's reply, and the closed list is what the screen has a sentence for.
 */
export const EMAIL_BOUNCE_REASONS = [
  'mailbox_not_found',
  'domain_not_found',
  'mailbox_full',
  'blocked',
  'other',
] as const;
export type EmailBounceReason = (typeof EMAIL_BOUNCE_REASONS)[number];

/** One event, normalized by an adapter. It holds ids and a type, and nothing about the person. */
export interface EmailProviderEvent {
  /** The provider's id for this delivery of the event: the key a replay is recognised by. */
  readonly providerEventId: string;
  /** The provider's id for the email, which is what our `provider_message_id` holds. */
  readonly providerMessageId: string;
  readonly type: EmailEventType;
  /** Only a permanent bounce counts; a temporary one is the provider's to retry and never reaches us. */
  readonly reason: EmailBounceReason | null;
  readonly at: Date;
}

/** Why an address is not written to. */
export const EMAIL_SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'unsubscribed'] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

/** The reason an event suppresses an address, or null when it does not. */
export function suppressionFor(type: EmailEventType): EmailSuppressionReason | null {
  if (type === 'bounced') return 'hard_bounce';
  if (type === 'complained') return 'complaint';
  if (type === 'unsubscribed') return 'unsubscribed';
  return null;
}

/**
 * The status an event moves an email to, or null when it moves nothing.
 *
 * Forward only: `sent` to `delivered`; `sent` or `delivered` to `bounced` or `complained` (a bounce can
 * be reported after a delivery). It never goes back, never touches `failed` or an email still in flight,
 * and a repeat of the same event changes nothing.
 */
export function statusAfter(current: EmailStatus, type: EmailEventType): EmailStatus | null {
  switch (type) {
    case 'delivered':
      return current === 'sent' ? 'delivered' : null;
    case 'bounced':
      return current === 'sent' || current === 'delivered' ? 'bounced' : null;
    case 'complained':
      return current === 'sent' || current === 'delivered' || current === 'bounced'
        ? 'complained'
        : null;
    case 'unsubscribed':
      // The person's refusal says nothing about whether the mail arrived: the status stays as it was.
      return null;
  }
}

/** The largest body the events door reads (batches are possible), cut off before parsing. */
export const EMAIL_EVENT_BODY_MAX_BYTES = 256 * 1024;
/** How far a signed request's timestamp may be from our clock. Our choice: the provider's page names none. */
export const EMAIL_EVENT_TOLERANCE_SECONDS = 300;

/**
 * When a company's email is paused: too many hard bounces or complaints, because every company shares one
 * sending address and a bad run harms them all. Constants, not configuration; the numbers are a proposal
 * the owner approved with the plan, not a standard that was verified.
 */
export const EMAIL_PAUSE = {
  /** How many of the most recent sent emails are looked at. */
  windowSent: 50,
  /** More than this many hard bounces among them pauses the company. */
  hardBouncesInWindow: 5,
  /** This many complaints in a day does. */
  complaintsPerDay: 3,
} as const;

export function shouldPauseEmail(counts: {
  readonly hardBouncesInWindow: number;
  readonly complaintsToday: number;
}): boolean {
  return (
    counts.hardBouncesInWindow > EMAIL_PAUSE.hardBouncesInWindow ||
    counts.complaintsToday >= EMAIL_PAUSE.complaintsPerDay
  );
}
