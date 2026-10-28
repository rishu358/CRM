import { describe, expect, it } from 'vitest';
import { toTimeZone } from '../dates/index.js';
import { IMPORT_DATE_MIN, parseOriginalDate } from './original-dates.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const IST = toTimeZone('Asia/Kolkata');
const LA = toTimeZone('America/Los_Angeles');
const UTC = toTimeZone('UTC');

const parse = (text: string, zone = IST) => parseOriginalDate(text, zone, NOW);
const iso = (text: string, zone = IST): string => {
  const result = parse(text, zone);
  if (!result.ok) throw new Error(result.message);
  return result.value.toISOString();
};
const refusal = (text: string, zone = IST): string => {
  const result = parse(text, zone);
  if (result.ok) throw new Error(`accepted ${text}`);
  return result.message;
};

describe('parseOriginalDate', () => {
  it('reads a date as the start of that day in the workspace time zone', () => {
    // Midnight in Kolkata is 18:30 the evening before in UTC.
    expect(iso('2024-03-31')).toBe('2024-03-30T18:30:00.000Z');
    expect(iso('2024-03-31', LA)).toBe('2024-03-31T07:00:00.000Z');
    expect(iso('2024-03-31', UTC)).toBe('2024-03-31T00:00:00.000Z');
  });

  it('reads a time without an offset as wall-clock time in the workspace zone', () => {
    expect(iso('2024-03-31 14:30')).toBe('2024-03-31T09:00:00.000Z');
    expect(iso('2024-03-31T14:30:05')).toBe('2024-03-31T09:00:05.000Z');
  });

  it('follows daylight saving in the zone it is read in', () => {
    // Los Angeles is UTC-8 before 2024-03-10 and UTC-7 after.
    expect(iso('2024-03-09 12:00', LA)).toBe('2024-03-09T20:00:00.000Z');
    expect(iso('2024-03-11 12:00', LA)).toBe('2024-03-11T19:00:00.000Z');
  });

  it('takes an explicit offset exactly, whatever the workspace zone', () => {
    expect(iso('2024-03-31T14:30:00Z')).toBe('2024-03-31T14:30:00.000Z');
    expect(iso('2024-03-31 14:30 +05:30', LA)).toBe('2024-03-31T09:00:00.000Z');
    expect(iso('2024-03-31T14:30-0800')).toBe('2024-03-31T22:30:00.000Z');
  });

  it('ignores spaces around the cell', () => {
    expect(iso('  2024-03-31  ')).toBe('2024-03-30T18:30:00.000Z');
  });

  it.each(['03/04/2024', '3-4-24', '31.03.2024', '2024/03/31', '14:30', 'yesterday', '24-03-31'])(
    'refuses %s rather than guess what it means',
    (text) => {
      expect(refusal(text)).toMatch(/Use YYYY-MM-DD/);
    },
  );

  it.each(['2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10'])(
    'refuses %s, a date that does not exist',
    (text) => {
      expect(refusal(text)).toMatch(/does not exist/);
    },
  );

  it('refuses a time that does not exist', () => {
    expect(refusal('2024-03-31 25:00')).toMatch(/does not exist/);
    expect(refusal('2024-03-31 12:61')).toMatch(/does not exist/);
  });

  it('accepts a leap day', () => {
    expect(iso('2024-02-29', UTC)).toBe('2024-02-29T00:00:00.000Z');
  });

  it('refuses the future, by an hour or by a year', () => {
    expect(refusal('2026-10-28T13:00:00Z')).toMatch(/future/);
    expect(refusal('2027-01-01')).toMatch(/future/);
    expect(iso('2026-10-28T12:00:00Z')).toBe('2026-10-28T12:00:00.000Z');
  });

  it('refuses a date before 1990, which is a typo or a tool empty date, not history', () => {
    expect(refusal('1899-12-31')).toMatch(/before 1990/);
    expect(refusal('1970-01-01')).toMatch(/before 1990/);
    expect(parse(IMPORT_DATE_MIN.toISOString().replace('.000Z', 'Z')).ok).toBe(true);
  });

  it('refuses an offset no zone has', () => {
    expect(refusal('2024-03-31 14:30 +23:00')).toMatch(/offset/);
  });
});
