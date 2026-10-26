import {
  endOfDayIn,
  plainDateIn,
  startOfDayIn,
  type PlainDate,
  type TimeZone,
} from '../dates/index.js';

/**
 * Activity domain rules (MVP_SPEC §M6, §6.2).
 *
 * Pure logic only: what the types are, when a reminder should fire, and which
 * bucket a task falls into on the viewer's calendar. Nothing here touches a
 * database or a request, so the awkward part — "today" in a time zone — is
 * testable without either.
 */

export const ACTIVITY_TYPES = ['task', 'call', 'meeting', 'note'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_PRIORITIES = ['low', 'normal', 'high'] as const;
export type ActivityPriority = (typeof ACTIVITY_PRIORITIES)[number];

export const ACTIVITY_STATUSES = ['open', 'completed', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * A note is a record of something that happened, not something to do.
 *
 * It therefore carries no due date, no reminder and no completion — the
 * database enforces the same rule, so an import cannot create a note that
 * shows up in somebody's overdue list (`0010_activities_module.sql`).
 */
export function isSchedulable(type: ActivityType): boolean {
  return type !== 'note';
}

/** Where an activity belongs on the My Day screen (MVP_SPEC M6). */
export const MY_DAY_BUCKETS = ['overdue', 'dueToday', 'upcoming'] as const;
export type MyDayBucket = (typeof MY_DAY_BUCKETS)[number];

/**
 * The instants that bound "today" for one viewer.
 *
 * The whole point of this function is that it takes a time zone. A task due at
 * 2026-10-18T00:30Z is due *today* for a viewer in Asia/Kolkata and *tomorrow*
 * for one in UTC; comparing `due_at` against UTC midnight silently moves other
 * people's work between days, and silently is the problem — nothing errors,
 * the list is just wrong for everyone who is not on UTC.
 */
export interface DayWindow {
  /** The calendar date this window describes, as the viewer sees it. */
  readonly date: PlainDate;
  /** Inclusive start of the viewer's day, as an absolute instant. */
  readonly start: Date;
  /** Exclusive end of the viewer's day, as an absolute instant. */
  readonly end: Date;
}

export function dayWindowFor(now: Date, timeZone: TimeZone): DayWindow {
  const date = plainDateIn(now, timeZone);
  return { date, start: startOfDayIn(date, timeZone), end: endOfDayIn(date, timeZone) };
}

/**
 * How far ahead "upcoming" reaches, in days of the viewer's calendar.
 *
 * Bounded rather than open-ended: a home screen listing every task to the end
 * of time is not a plan for the day, and an unbounded range makes the query
 * scan the whole table.
 */
export const UPCOMING_DAYS = 7;

export function upcomingEnd(window: DayWindow, timeZone: TimeZone, days = UPCOMING_DAYS): Date {
  // Walk forward from the end of today by whole days, through the time zone
  // each time, so a DST transition inside the window does not shift the edge.
  let edge = window.end;
  for (let day = 1; day < days; day += 1) {
    edge = endOfDayIn(plainDateIn(edge, timeZone), timeZone);
  }
  return edge;
}

/**
 * Which bucket an open activity falls into for this viewer, or null when it
 * is further out than the upcoming window.
 *
 * Mirrors the SQL the repository runs, and is the in-memory twin the tests
 * compare against — the same arrangement `satisfiesConstraint` has with the
 * record-scope SQL, and for the same reason: two implementations that must
 * agree are worth being able to check against each other.
 */
export function bucketFor(
  dueAt: Date | null,
  window: DayWindow,
  upcomingLimit: Date,
): MyDayBucket | null {
  if (dueAt === null) return null;
  if (dueAt < window.start) return 'overdue';
  if (dueAt < window.end) return 'dueToday';
  return dueAt < upcomingLimit ? 'upcoming' : null;
}

/**
 * When to remind the assignee about a task.
 *
 * Defaults to the due time itself. A reminder is only ever scheduled for a
 * schedulable type with a due date, and never in the past: a task created with
 * a due date that has already passed is already overdue on My Day, and firing
 * a "due soon" notification for it would be noise rather than news
 * (ADR-0025).
 */
export function reminderInstantFor(
  type: ActivityType,
  dueAt: Date | null,
  now: Date,
  leadMinutes = 0,
): Date | null {
  if (!isSchedulable(type) || dueAt === null) return null;
  const instant = new Date(dueAt.getTime() - leadMinutes * 60_000);
  return instant.getTime() <= now.getTime() ? null : instant;
}
