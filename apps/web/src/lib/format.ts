/**
 * Shared formatters (ADR-0011, CLAUDE.md §9).
 *
 * No component formats a number, a date or an amount itself. Indian users
 * expect lakh/crore grouping and a tenant in another country expects its own —
 * one place to get that right, and one place to fix it.
 */
export interface ViewerPreferences {
  readonly locale: string;
  readonly timeZone: string;
}

export const DEFAULT_PREFERENCES: ViewerPreferences = {
  locale: 'en-IN',
  timeZone: 'Asia/Kolkata',
};

export function formatDateTime(iso: string, preferences: ViewerPreferences): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(preferences.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: preferences.timeZone,
  }).format(date);
}

export function formatDate(iso: string, preferences: ViewerPreferences): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(preferences.locale, {
    dateStyle: 'medium',
    timeZone: preferences.timeZone,
  }).format(date);
}

/** Amounts arrive as minor units in a string, so nothing is rounded in transit. */
export function formatMoney(
  amountMinor: string,
  currency: string,
  preferences: ViewerPreferences,
): string {
  const exponent = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  const major = Number(amountMinor) / 10 ** exponent;
  return new Intl.NumberFormat(preferences.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}

export function formatName(contact: { firstName?: unknown; lastName?: unknown }): string {
  const parts = [contact.firstName, contact.lastName].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.join(' ');
}

/**
 * A count of things, grouped the way the viewer reads numbers (lakh/crore for
 * `en-IN`). Counts of records are shown to administrators making a decision, so
 * `1,24,000` must not be mistaken for `124,000` by someone used to the other.
 */
export function formatCount(value: number, preferences: ViewerPreferences): string {
  return new Intl.NumberFormat(preferences.locale).format(value);
}
