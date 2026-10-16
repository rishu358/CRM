/**
 * Money (ADR-0011).
 *
 * Amounts are integer **minor units** (paise, cents) held in `bigint`, paired
 * with an ISO-4217 code. Floats are never used: `0.1 + 0.2 !== 0.3` in IEEE-754,
 * and a CRM that computes tax and discounts on floats will eventually disagree
 * with a customer's invoice by a rupee and have no way to explain why.
 */

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface Money {
  /** Integer minor units. 150075n with INR means ₹1,500.75. */
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/**
 * Minor-unit exponents for the currencies we expect to meet.
 * Most are 2; the exceptions are real and get this wrong silently if ignored.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  CLP: 0,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  OMR: 3,
  TND: 3,
  VND: 0,
};
const DEFAULT_MINOR_UNIT_EXPONENT = 2;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class CurrencyMismatchError extends Error {
  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`Cannot combine ${left} with ${right}: convert explicitly first`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Validate and brand an ISO-4217 code. Throws on anything else. */
export function toCurrency(code: string): CurrencyCode {
  const upper = code.toUpperCase();
  if (!CURRENCY_PATTERN.test(upper)) {
    throw new TypeError(`Invalid ISO-4217 currency code: ${code}`);
  }
  return upper as CurrencyCode;
}

/** How many decimal places this currency's minor unit represents. */
export function minorUnitExponent(currency: CurrencyCode): number {
  return MINOR_UNIT_EXPONENTS[currency] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

export function money(amountMinor: bigint | number, currency: string): Money {
  if (typeof amountMinor === 'number' && !Number.isInteger(amountMinor)) {
    throw new TypeError(
      `Money must be whole minor units, got ${amountMinor}. ` +
        'Multiply by the minor-unit factor before constructing Money.',
    );
  }
  return { amountMinor: BigInt(amountMinor), currency: toCurrency(currency) };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce<Money>((acc, item) => add(acc, item), zero(currency));
}

/**
 * Multiply by a rational factor given as `numerator / denominator`, rounding
 * half-up on the absolute value so that -0.5 and 0.5 round symmetrically.
 *
 * Callers pass a ratio rather than a float precisely so no float ever enters
 * the calculation. A 7.5% probability weighting is `multiply(m, 75n, 1000n)`.
 */
export function multiply(value: Money, numerator: bigint, denominator: bigint): Money {
  if (denominator === 0n) throw new RangeError('Denominator must not be zero');

  const product = value.amountMinor * numerator;
  const negative = product < 0n !== denominator < 0n;
  const absProduct = product < 0n ? -product : product;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absProduct / absDenominator;
  const remainder = absProduct % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return { amountMinor: negative ? -rounded : rounded, currency: value.currency };
}

/**
 * Split an amount into `parts` shares that sum **exactly** back to the original.
 *
 * Dividing 100 by 3 and rounding each share would lose or invent a minor unit.
 * The remainder is instead distributed one unit at a time across the leading
 * shares, so nothing is created or destroyed.
 */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError('parts must be a positive integer');
  }
  const count = BigInt(parts);
  const negative = value.amountMinor < 0n;
  const total = negative ? -value.amountMinor : value.amountMinor;

  const base = total / count;
  let remainder = total % count;

  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder > 0n) {
      share += 1n;
      remainder -= 1n;
    }
    return { amountMinor: negative ? -share : share, currency: value.currency };
  });
}

/**
 * Format for display. `locale` drives grouping, so `en-IN` produces the
 * lakh/crore grouping Indian users expect (MVP_SPEC §1) with no special case here.
 */
export function format(value: Money, locale: string): string {
  const exponent = minorUnitExponent(value.currency);
  const divisor = 10 ** exponent;
  // Safe: display only. All arithmetic above stays in bigint.
  const major = Number(value.amountMinor) / divisor;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}

/** Parse a major-unit decimal string ("1500.75") into exact minor units. */
export function fromMajorString(input: string, currency: string): Money {
  const code = toCurrency(currency);
  const exponent = minorUnitExponent(code);
  const trimmed = input.trim();

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new TypeError(`Not a valid decimal amount: ${input}`);

  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new RangeError(
      `${currency} supports ${exponent} decimal places, got ${fraction.length} in "${input}"`,
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt(whole) * BigInt(10 ** exponent) + BigInt(padded === '' ? '0' : padded);
  return { amountMinor: sign === '-' ? -minor : minor, currency: code };
}
