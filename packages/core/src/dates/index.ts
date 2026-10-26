/**
 * Dates and time zones (ADR-0011).
 *
 * Everything is stored as `timestamptz` in UTC and displayed in the viewer's
 * time zone. The rule that prevents nearly every time-zone bug: a `Date` in this
 * codebase is always an absolute instant, never a wall-clock reading. Converting
 * to wall-clock happens only at the display boundary, in the functions below.
 *
 * Built on the Intl API rather than a date library, so there is no dependency to
 * keep current and the IANA database ships with the runtime.
 */

/** An IANA time zone name, e.g. "Asia/Kolkata". */
export type TimeZone = string & { readonly __brand: 'TimeZone' };

/** A calendar date with no time or zone, as stored in a `date` column. */
export type PlainDate = string & { readonly __brand: 'PlainDate' };

const PLAIN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isTimeZone(value: unknown): value is TimeZone {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function toTimeZone(value: string): TimeZone {
  if (!isTimeZone(value)) throw new TypeError(`Unknown IANA time zone: ${value}`);
  return value;
}

export function isPlainDate(value: unknown): value is PlainDate {
  if (typeof value !== 'string' || !PLAIN_DATE_PATTERN.test(value)) return false;
  // Reject calendar-shaped but non-existent dates such as 2026-02-30.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function toPlainDate(value: string): PlainDate {
  if (!isPlainDate(value)) throw new TypeError(`Not a valid calendar date: ${value}`);
  return value;
}

/** Decompose an instant into wall-clock parts in `timeZone`. */
function partsIn(instant: Date, timeZone: TimeZone): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    if (type !== 'literal') {
      // Intl renders midnight as hour 24 in some locales; normalise it.
      parts[type] = type === 'hour' && value === '24' ? 0 : Number(value);
    }
  }
  return parts;
}

/** The calendar date an instant falls on, as seen in `timeZone`. */
export function plainDateIn(instant: Date, timeZone: TimeZone): PlainDate {
  const p = partsIn(instant, timeZone);
  const year = String(p.year ?? 0).padStart(4, '0');
  const month = String(p.month ?? 1).padStart(2, '0');
  const day = String(p.day ?? 1).padStart(2, '0');
  return `${year}-${month}-${day}` as PlainDate;
}

/**
 * The UTC offset of `timeZone` at `instant`, in minutes.
 *
 * Computed from the zone's own rendering of the instant, so DST transitions and
 * historical offset changes are handled by the runtime's IANA data rather than
 * by us.
 */
export function offsetMinutes(instant: Date, timeZone: TimeZone): number {
  const p = partsIn(instant, timeZone);
  const asUtc = Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  // `asUtc` has second precision, so drop the instant's milliseconds before
  // differencing; no modern zone uses a sub-minute offset.
  const instantToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - instantToSecond) / 60000);
}

/**
 * The instant at which a calendar day starts in `timeZone`.
 *
 * This is what "due today" and any date-range filter must be built from: a
 * tenant in Asia/Kolkata and one in America/Los_Angeles do not share a "today",
 * and comparing against UTC midnight silently shifts records between days.
 */
export function startOfDayIn(date: PlainDate, timeZone: TimeZone): Date {
  const naive = new Date(`${date}T00:00:00Z`);
  // Guess, then correct using the offset actually in force at the guess.
  const firstPass = new Date(naive.getTime() - offsetMinutes(naive, timeZone) * 60000);
  const corrected = new Date(naive.getTime() - offsetMinutes(firstPass, timeZone) * 60000);
  return corrected;
}

/** The exclusive end of a calendar day in `timeZone`. */
export function endOfDayIn(date: PlainDate, timeZone: TimeZone): Date {
  const start = startOfDayIn(date, timeZone);
  const nextDay = new Date(start.getTime() + 36 * 3600 * 1000);
  return startOfDayIn(plainDateIn(nextDay, timeZone), timeZone);
}

/** Format an instant for display in the viewer's locale and zone. */
export function formatDateTime(
  instant: Date,
  locale: string,
  timeZone: TimeZone,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(instant);
}

export function formatDate(instant: Date, locale: string, timeZone: TimeZone): string {
  return formatDateTime(instant, locale, timeZone, { dateStyle: 'medium' });
}

/**
 * A timestamp read from a raw SQL result, as an instant.
 *
 * Drizzle's `tx.execute` returns `timestamptz` columns as **strings**, while its
 * query builder returns `Date`s, so a raw row typed as `Date` is a type that
 * compiles and then fails at the first `.toISOString()`. Anything that reads a
 * timestamp out of `execute` goes through here, and the row type says
 * `Date | string` so the compiler insists on it.
 */
export function asInstant(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Parse an untrusted ISO-8601 string into an instant, or throw. */
export function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Not a valid ISO-8601 instant: ${value}`);
  }
  return parsed;
}
