import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../fields/types.js';
import { coerceCell, formatCell, formatMinor } from './cells.js';

const def = (
  type: FieldDefinition['type'],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  key: 'f',
  label: 'F',
  type,
  required: false,
  isSystem: false,
  isActive: true,
  position: 1,
  ...extra,
});

const options = [
  { value: 'hot', label: 'Hot lead' },
  { value: 'cold', label: 'Cold' },
  { value: 'old', label: 'Old', isActive: false },
];

describe('coerceCell', () => {
  it('treats a blank cell as "not supplied", never as null or an empty string', () => {
    expect(coerceCell(def('text'), '   ')).toEqual({ ok: true, blank: true, value: undefined });
  });

  it('keeps text as text, including text that looks like a number', () => {
    expect(coerceCell(def('text'), ' 0042 ')).toEqual({ ok: true, value: '0042' });
  });

  it('strips the punctuation people type in phone numbers', () => {
    expect(coerceCell(def('phone'), '+91 (98765) 43-210')).toEqual({
      ok: true,
      value: '+919876543210',
    });
  });

  it('parses numbers with thousands separators and rejects words', () => {
    expect(coerceCell(def('number'), '1,00,000.5')).toEqual({ ok: true, value: 100000.5 });
    expect(coerceCell(def('percent'), '45%')).toEqual({ ok: true, value: 45 });
    expect(coerceCell(def('number'), 'twelve')).toMatchObject({ ok: false });
  });

  it('parses booleans in the words people use and refuses anything else', () => {
    for (const word of ['yes', 'TRUE', 'y', '1']) {
      expect(coerceCell(def('boolean'), word)).toEqual({ ok: true, value: true });
    }
    for (const word of ['No', 'false', 'n', '0']) {
      expect(coerceCell(def('boolean'), word)).toEqual({ ok: true, value: false });
    }
    expect(coerceCell(def('boolean'), 'maybe')).toMatchObject({ ok: false });
  });

  it('matches a picklist by value or by label, case-insensitively, active options only', () => {
    const picklist = def('picklist', { options });
    expect(coerceCell(picklist, 'HOT')).toEqual({ ok: true, value: 'hot' });
    expect(coerceCell(picklist, 'hot lead')).toEqual({ ok: true, value: 'hot' });
    expect(coerceCell(picklist, 'Old')).toMatchObject({ ok: false });
    expect(coerceCell(picklist, 'lukewarm')).toMatchObject({ ok: false });
  });

  it('splits a multi-picklist on ; or | and de-duplicates', () => {
    const multi = def('multi_picklist', { options });
    expect(coerceCell(multi, 'hot; Cold | hot')).toEqual({ ok: true, value: ['hot', 'cold'] });
    expect(coerceCell(multi, 'hot; nope')).toMatchObject({ ok: false });
  });

  describe('currency', () => {
    it('reads an amount with a code before or after, exactly', () => {
      const expected = { ok: true, value: { amount_minor: '150075', currency: 'INR' } };
      expect(coerceCell(def('currency'), '1500.75 INR')).toEqual(expected);
      expect(coerceCell(def('currency'), 'inr 1,500.75')).toEqual(expected);
    });

    it('uses the currency’s own minor-unit exponent', () => {
      expect(coerceCell(def('currency'), '500 JPY')).toEqual({
        ok: true,
        value: { amount_minor: '500', currency: 'JPY' },
      });
      expect(coerceCell(def('currency'), '1.5 JPY')).toMatchObject({ ok: false });
    });

    it('keeps precision beyond 2^53', () => {
      expect(coerceCell(def('currency'), '90071992547409.93 USD')).toEqual({
        ok: true,
        value: { amount_minor: '9007199254740993', currency: 'USD' },
      });
    });

    it('refuses a bare number, because guessing the currency is how money goes wrong', () => {
      expect(coerceCell(def('currency'), '1500.75')).toMatchObject({ ok: false });
    });

    it('refuses too many decimals and nonsense', () => {
      expect(coerceCell(def('currency'), '1.005 USD')).toMatchObject({ ok: false });
      expect(coerceCell(def('currency'), 'lots')).toMatchObject({ ok: false });
    });
  });
});

describe('formatCell', () => {
  it('renders nothing for null, and typed values as the text a spreadsheet shows', () => {
    expect(formatCell(def('text'), null)).toBe('');
    expect(formatCell(def('boolean'), true)).toBe('true');
    expect(formatCell(def('multi_picklist'), ['a', 'b'])).toBe('a; b');
    expect(formatCell(def('number'), 42)).toBe('42');
  });

  it('renders currency exactly, as the same text the importer reads', () => {
    const value = { amount_minor: '150075', currency: 'INR' };
    expect(formatCell(def('currency'), value)).toBe('1500.75 INR');
    expect(coerceCell(def('currency'), formatCell(def('currency'), value))).toEqual({
      ok: true,
      value,
    });
  });

  it('does not escape: that is the writer’s job, on every cell', () => {
    expect(formatCell(def('text'), '=1+1')).toBe('=1+1');
  });
});

describe('formatMinor', () => {
  it('handles negatives, zero, small amounts and zero-decimal currencies', () => {
    expect(formatMinor(-150075n, 'INR')).toBe('-1500.75 INR');
    expect(formatMinor(0n, 'INR')).toBe('0.00 INR');
    expect(formatMinor(5n, 'INR')).toBe('0.05 INR');
    expect(formatMinor(500n, 'JPY')).toBe('500 JPY');
    expect(formatMinor(9007199254740993n, 'USD')).toBe('90071992547409.93 USD');
  });
});
