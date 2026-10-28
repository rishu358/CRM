import { offsetMinutes, startOfDayIn, toPlainDate, type TimeZone } from '../dates/index.js';

/**
 * The original creation date of a record, as a spreadsheet gives it (ADR-0069).
 *
 * A business moving in wants "created" to mean when the record really began, not the day the file was
 * imported. This is the one place a cell becomes that instant, and it is strict on purpose: a date
 * that could mean two things is refused, never guessed, because a wrong creation date is a quiet
 * corruption of every report that reads it (CLAUDE.md §11.8).
 *
 * Accepted:
 *   `2024-03-31`              the start of that day in the workspace's time zone
 *   `2024-03-31 14:30`        a wall-clock time in the workspace's time zone (`T` instead of a space is fine)
 *   `2024-03-31 14:30:05`     the same, with seconds
 *   `2024-03-31T14:30:05Z`    an exact instant, with `Z` or a `+05:30` / `-0800` offset
 *
 * Refused: `03/04/2024` (3 April or 4 March), a two-digit year, a bare time, a date that does not
 * exist (`2024-02-30`), a date in the future, and a date before 1990.
 */

/** Earlier than this is a typo, not history: 1900-01-01 is what a blank date becomes in some tools. */
export const IMPORT_DATE_MIN = new Date('1990-01-01T00:00:00.000Z');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i;

export type OriginalDateResult =
  { readonly ok: true; readonly value: Date } | { readonly ok: false; readonly message: string };

const FORMAT_HELP = 'Use YYYY-MM-DD, or YYYY-MM-DD HH:MM';

function real(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/** The instant a wall-clock reading denotes in `timeZone` (same two-pass correction as `startOfDayIn`). */
function wallClockIn(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: TimeZone,
): Date {
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const firstPass = new Date(naive.getTime() - offsetMinutes(naive, timeZone) * 60000);
  return new Date(naive.getTime() - offsetMinutes(firstPass, timeZone) * 60000);
}

export function parseOriginalDate(raw: string, timeZone: TimeZone, now: Date): OriginalDateResult {
  const text = raw.trim();
  let instant: Date;

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly !== null) {
    const [year, month, day] = [
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    ] as const;
    if (!real(year, month, day, 0, 0, 0)) return { ok: false, message: 'That date does not exist' };
    instant = startOfDayIn(toPlainDate(text), timeZone);
  } else {
    const dateTime = DATE_TIME.exec(text);
    if (dateTime === null) return { ok: false, message: FORMAT_HELP };
    const [year, month, day, hour, minute] = [
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
    ] as const;
    const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
    if (!real(year, month, day, hour, minute, second)) {
      return { ok: false, message: 'That date or time does not exist' };
    }

    const zone = dateTime[7];
    if (zone === undefined) {
      instant = wallClockIn(year, month, day, hour, minute, second, timeZone);
    } else {
      const utc = Date.UTC(year, month - 1, day, hour, minute, second);
      if (zone.toUpperCase() === 'Z') {
        instant = new Date(utc);
      } else {
        const sign = zone.startsWith('-') ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
        if (Math.abs(offset) > 14 * 60)
          return { ok: false, message: 'That time zone offset is not valid' };
        instant = new Date(utc - offset * 60000);
      }
    }
  }

  if (instant.getTime() > now.getTime()) {
    return { ok: false, message: 'An original date cannot be in the future' };
  }
  if (instant.getTime() < IMPORT_DATE_MIN.getTime()) {
    return { ok: false, message: 'An original date cannot be before 1990' };
  }
  return { ok: true, value: instant };
}
