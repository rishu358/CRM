import { describe, expect, it } from 'vitest';
import {
  endOfDayIn,
  formatDate,
  isPlainDate,
  isTimeZone,
  offsetMinutes,
  parseInstant,
  plainDateIn,
  startOfDayIn,
  toPlainDate,
  toTimeZone,
} from './index.js';

const KOLKATA = toTimeZone('Asia/Kolkata');
const LA = toTimeZone('America/Los_Angeles');
const UTC = toTimeZone('UTC');

describe('time zone validation', () => {
  it('accepts IANA names and rejects anything else', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(null)).toBe(false);
    expect(() => toTimeZone('Not/AZone')).toThrow(TypeError);
  });
});

describe('plain date validation', () => {
  it('rejects calendar-shaped but impossible dates', () => {
    expect(isPlainDate('2026-02-28')).toBe(true);
    expect(isPlainDate('2026-02-30')).toBe(false);
    expect(isPlainDate('2026-13-01')).toBe(false);
    expect(isPlainDate('2026-2-1')).toBe(false);
    expect(() => toPlainDate('nonsense')).toThrow(TypeError);
  });

  it('accepts a real leap day', () => {
    expect(isPlainDate('2028-02-29')).toBe(true);
    expect(isPlainDate('2026-02-29')).toBe(false);
  });
});

describe('offsetMinutes', () => {
  it('handles the half-hour offset India uses', () => {
    expect(offsetMinutes(new Date('2026-06-15T12:00:00Z'), KOLKATA)).toBe(330);
  });

  it('tracks daylight saving transitions', () => {
    // Los Angeles is UTC-8 in January and UTC-7 in July.
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), LA)).toBe(-480);
    expect(offsetMinutes(new Date('2026-07-15T12:00:00Z'), LA)).toBe(-420);
  });

  it('is zero for UTC', () => {
    expect(offsetMinutes(new Date('2026-06-15T12:00:00Z'), UTC)).toBe(0);
  });
});

describe('plainDateIn', () => {
  it('gives different tenants different "today" for the same instant', () => {
    // 19:00 UTC is already the next day in Kolkata but still the same day in LA.
    const instant = new Date('2026-03-10T19:00:00Z');
    expect(plainDateIn(instant, KOLKATA)).toBe('2026-03-11');
    expect(plainDateIn(instant, LA)).toBe('2026-03-10');
  });
});

describe('startOfDayIn / endOfDayIn', () => {
  it('anchors a day to the tenant zone, not UTC midnight', () => {
    // Midnight in Kolkata is 18:30 UTC the previous day.
    expect(startOfDayIn(toPlainDate('2026-03-11'), KOLKATA).toISOString()).toBe(
      '2026-03-10T18:30:00.000Z',
    );
  });

  it('produces an exclusive end exactly one day later', () => {
    const start = startOfDayIn(toPlainDate('2026-06-15'), KOLKATA);
    const end = endOfDayIn(toPlainDate('2026-06-15'), KOLKATA);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('survives a spring-forward day that is only 23 hours long', () => {
    // US DST begins 2026-03-08; that local day has 23 hours.
    const start = startOfDayIn(toPlainDate('2026-03-08'), LA);
    const end = endOfDayIn(toPlainDate('2026-03-08'), LA);
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
    expect(start.toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });

  it('survives a fall-back day that is 25 hours long', () => {
    // US DST ends 2026-11-01.
    const start = startOfDayIn(toPlainDate('2026-11-01'), LA);
    const end = endOfDayIn(toPlainDate('2026-11-01'), LA);
    expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });
});

describe('formatDate', () => {
  it('renders the date as seen in the given zone', () => {
    const instant = new Date('2026-03-10T19:00:00Z');
    expect(formatDate(instant, 'en-IN', KOLKATA)).toContain('11');
    expect(formatDate(instant, 'en-US', LA)).toContain('10');
  });
});

describe('parseInstant', () => {
  it('rejects junk rather than producing an Invalid Date', () => {
    expect(() => parseInstant('not a date')).toThrow(TypeError);
    expect(parseInstant('2026-06-15T12:00:00Z').toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });
});
