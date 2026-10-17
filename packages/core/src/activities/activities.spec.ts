import { describe, expect, it } from 'vitest';
import { toTimeZone } from '../dates/index.js';
import {
  bucketFor,
  dayWindowFor,
  isSchedulable,
  reminderInstantFor,
  upcomingEnd,
} from './index.js';

/**
 * The time-zone cases are the point of this file.
 *
 * Kolkata is UTC+5:30 — a half-hour offset, which catches arithmetic that
 * assumes whole hours — and Los Angeles crosses DST, which catches arithmetic
 * that assumes a day is always 24 hours long.
 */
const KOLKATA = toTimeZone('Asia/Kolkata');
const LOS_ANGELES = toTimeZone('America/Los_Angeles');
const UTC = toTimeZone('UTC');

describe('dayWindowFor', () => {
  it('uses the viewer calendar date, not the UTC one', () => {
    // 19:30 UTC on the 17th is already 01:00 on the 18th in Kolkata.
    const now = new Date('2026-10-17T19:30:00Z');
    expect(dayWindowFor(now, KOLKATA).date).toBe('2026-10-18');
    expect(dayWindowFor(now, UTC).date).toBe('2026-10-17');
  });

  it('starts the day at local midnight, half-hour offset included', () => {
    const window = dayWindowFor(new Date('2026-10-17T06:00:00Z'), KOLKATA);
    expect(window.start.toISOString()).toBe('2026-10-16T18:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-17T18:30:00.000Z');
  });

  it('spans 25 hours on the day a DST transition adds one', () => {
    // 1 November 2026: America/Los_Angeles falls back from PDT to PST.
    const window = dayWindowFor(new Date('2026-11-01T18:00:00Z'), LOS_ANGELES);
    const hours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
    expect(window.date).toBe('2026-11-01');
    expect(hours).toBe(25);
  });
});

describe('bucketFor', () => {
  const now = new Date('2026-10-17T06:00:00Z');
  const window = dayWindowFor(now, KOLKATA);
  const limit = upcomingEnd(window, KOLKATA);

  it('puts a task due yesterday evening in overdue', () => {
    expect(bucketFor(new Date('2026-10-16T12:00:00Z'), window, limit)).toBe('overdue');
  });

  it('puts a task due later today in dueToday', () => {
    expect(bucketFor(new Date('2026-10-17T12:00:00Z'), window, limit)).toBe('dueToday');
  });

  it('puts a task due just after local midnight in upcoming, not today', () => {
    // 18:45Z is 00:15 tomorrow in Kolkata: tomorrow for this viewer, today for
    // anyone comparing against UTC midnight. This is the bug the window exists
    // to prevent.
    const justAfterLocalMidnight = new Date('2026-10-17T18:45:00Z');
    expect(bucketFor(justAfterLocalMidnight, window, limit)).toBe('upcoming');

    const utcWindow = dayWindowFor(now, UTC);
    expect(bucketFor(justAfterLocalMidnight, utcWindow, upcomingEnd(utcWindow, UTC))).toBe(
      'dueToday',
    );
  });

  it('leaves a task beyond the upcoming window out of every bucket', () => {
    expect(bucketFor(new Date('2026-12-01T06:00:00Z'), window, limit)).toBeNull();
  });

  it('leaves an activity with no due date out of every bucket', () => {
    expect(bucketFor(null, window, limit)).toBeNull();
  });
});

describe('upcomingEnd', () => {
  it('covers whole local days, across a DST change', () => {
    const window = dayWindowFor(new Date('2026-10-30T18:00:00Z'), LOS_ANGELES);
    const end = upcomingEnd(window, LOS_ANGELES, 7);
    // Seven local days later, still at local midnight rather than drifting an
    // hour when the clocks change on 1 November.
    expect(end.toISOString()).toBe('2026-11-06T08:00:00.000Z');
  });
});

describe('reminderInstantFor', () => {
  const now = new Date('2026-10-17T06:00:00Z');

  it('schedules a task reminder at its due time', () => {
    const due = new Date('2026-10-18T06:00:00Z');
    expect(reminderInstantFor('task', due, now)?.toISOString()).toBe('2026-10-18T06:00:00.000Z');
  });

  it('can lead the due time by a number of minutes', () => {
    const due = new Date('2026-10-18T06:00:00Z');
    expect(reminderInstantFor('meeting', due, now, 30)?.toISOString()).toBe(
      '2026-10-18T05:30:00.000Z',
    );
  });

  it('schedules nothing for a note, which has nothing to be due', () => {
    expect(isSchedulable('note')).toBe(false);
    expect(reminderInstantFor('note', new Date('2026-10-18T06:00:00Z'), now)).toBeNull();
  });

  it('schedules nothing in the past: an overdue task is already on My Day', () => {
    expect(reminderInstantFor('task', new Date('2026-10-16T06:00:00Z'), now)).toBeNull();
    expect(reminderInstantFor('task', null, now)).toBeNull();
  });
});
