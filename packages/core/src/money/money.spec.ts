import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  add,
  allocate,
  compare,
  format,
  fromMajorString,
  minorUnitExponent,
  money,
  multiply,
  subtract,
  sum,
  toCurrency,
  zero,
} from './index.js';

describe('construction', () => {
  it('rejects fractional minor units', () => {
    expect(() => money(10.5, 'INR')).toThrow(/whole minor units/);
  });

  it('rejects malformed currency codes', () => {
    for (const bad of ['IN', 'INRR', '1NR', '']) {
      expect(() => toCurrency(bad)).toThrow();
    }
  });

  it('normalises currency case', () => {
    expect(money(1n, 'inr').currency).toBe('INR');
  });
});

describe('currency safety', () => {
  it('refuses to add different currencies rather than guessing a rate', () => {
    expect(() => add(money(100n, 'INR'), money(100n, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('refuses to compare different currencies', () => {
    expect(() => compare(money(100n, 'INR'), money(100n, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('arithmetic is exact', () => {
  it('does not drift the way floats do', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; in minor units it is exact.
    const result = add(money(10n, 'USD'), money(20n, 'USD'));
    expect(result.amountMinor).toBe(30n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = money(9007199254740993n, 'INR');
    expect(add(huge, money(1n, 'INR')).amountMinor).toBe(9007199254740994n);
  });

  it('subtracts into negatives', () => {
    expect(subtract(money(100n, 'INR'), money(250n, 'INR')).amountMinor).toBe(-150n);
  });

  it('sums an empty list to zero of the given currency', () => {
    expect(sum([], 'INR')).toEqual(zero('INR'));
  });
});

describe('multiply', () => {
  it('rounds half up', () => {
    // 101 * 1/2 = 50.5 -> 51
    expect(multiply(money(101n, 'USD'), 1n, 2n).amountMinor).toBe(51n);
  });

  it('rounds negatives symmetrically', () => {
    expect(multiply(money(-101n, 'USD'), 1n, 2n).amountMinor).toBe(-51n);
  });

  it('applies a percentage without floats', () => {
    // 18% GST on ₹1,000.00
    expect(multiply(money(100000n, 'INR'), 18n, 100n).amountMinor).toBe(18000n);
  });

  it('rejects a zero denominator', () => {
    expect(() => multiply(money(1n, 'USD'), 1n, 0n)).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('never loses or invents a minor unit', () => {
    const shares = allocate(money(100n, 'USD'), 3);
    expect(shares.map((s) => s.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(sum(shares, 'USD').amountMinor).toBe(100n);
  });

  it('round-trips negatives too', () => {
    const shares = allocate(money(-100n, 'USD'), 3);
    expect(sum(shares, 'USD').amountMinor).toBe(-100n);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocate(money(100n, 'USD'), 0)).toThrow(RangeError);
  });
});

describe('minor unit exponents', () => {
  it('knows the zero-decimal and three-decimal exceptions', () => {
    expect(minorUnitExponent(toCurrency('JPY'))).toBe(0);
    expect(minorUnitExponent(toCurrency('KWD'))).toBe(3);
    expect(minorUnitExponent(toCurrency('INR'))).toBe(2);
  });
});

describe('fromMajorString', () => {
  it('parses decimals exactly', () => {
    expect(fromMajorString('1500.75', 'INR').amountMinor).toBe(150075n);
    expect(fromMajorString('-0.01', 'USD').amountMinor).toBe(-1n);
    expect(fromMajorString('1500', 'INR').amountMinor).toBe(150000n);
  });

  it('respects zero-decimal currencies', () => {
    expect(fromMajorString('1500', 'JPY').amountMinor).toBe(1500n);
    expect(() => fromMajorString('1500.75', 'JPY')).toThrow(RangeError);
  });

  it('rejects junk rather than coercing it', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,500.75', '1e5']) {
      expect(() => fromMajorString(bad, 'INR')).toThrow();
    }
  });
});

describe('format', () => {
  it('uses lakh/crore grouping for en-IN', () => {
    // ₹1,23,45,678.90 — Indian grouping, not 12,345,678.90
    const formatted = format(money(1234567890n, 'INR'), 'en-IN');
    expect(formatted).toContain('1,23,45,678');
  });

  it('uses Western grouping for en-US', () => {
    expect(format(money(1234567890n, 'USD'), 'en-US')).toContain('12,345,678');
  });
});
