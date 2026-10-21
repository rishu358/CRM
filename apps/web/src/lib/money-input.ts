import { minorUnitExponent, toCurrency } from '@crm/core';

/**
 * Typing an amount: the conversions between what a person writes (`1500.75`, major
 * units, as on an invoice) and what is stored and sent (minor units, as digits).
 *
 * Shared by every control that edits money, so the browser never multiplies by 100
 * in floating point and never decides for itself how many decimal places a currency
 * has (JPY has none, KWD has three). The scale comes from `@crm/core`.
 */

/** The currencies the pickers offer. Others can still arrive in data. */
export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;

/**
 * Minor units back to the major-unit string a person would type.
 *
 * Done on the digits rather than by dividing, so an amount past 2^53 shows the value
 * that is stored rather than a rounded one.
 */
export function toMajorString(amountMinor: string, currency: string): string {
  let scale: number;
  try {
    scale = minorUnitExponent(toCurrency(currency));
  } catch {
    return amountMinor;
  }

  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
