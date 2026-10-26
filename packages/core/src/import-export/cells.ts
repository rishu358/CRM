import { minorUnitExponent, toCurrency } from '../money/index.js';
import type { FieldDefinition } from '../fields/types.js';
import { plainText } from './escaping.js';

/**
 * Spreadsheet cell <-> typed field value (MVP_SPEC §M8).
 *
 * A file is strings all the way down; a record is typed. This is the one place
 * that converts, and it is driven by the field's metadata type so a custom
 * field of any type imports and exports without anyone writing a case for it.
 *
 * Conversion is **not** validation. `coerceCell` makes a best, unambiguous
 * effort to give the value its type; the field schema (`buildFieldValueSchema`
 * for custom fields, the contract schema for system fields) then decides
 * whether it is acceptable. Keeping the two apart means the import cannot hold
 * a looser definition of "valid" than a form does.
 *
 * Where a cell could mean two things it is refused, not guessed: `03/04/2026`
 * is 3 April or 4 March depending on who typed it, and a CRM that picks one
 * silently has just corrupted a close date.
 */

export type CellResult =
  | { readonly ok: true; readonly value: unknown }
  /** The cell was blank: "not supplied", which is not the same as "set to null". */
  | { readonly ok: true; readonly blank: true; readonly value: undefined }
  | { readonly ok: false; readonly message: string };

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

/** Phone cells arrive as "+91 98765-43210". Strip the punctuation people type. */
function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-().]/g, '');
}

/** Accept a picklist cell by value or by label, case-insensitively. */
function matchOption(definition: FieldDefinition, raw: string): string | null {
  const wanted = raw.trim().toLowerCase();
  for (const option of definition.options ?? []) {
    if (option.isActive === false) continue;
    if (option.value.toLowerCase() === wanted || option.label.toLowerCase() === wanted) {
      return option.value;
    }
  }
  return null;
}

/** `1500.75 INR`, `INR 1500.75`, `1,500.75 inr` -> minor units, exactly. */
function parseCurrency(raw: string): CellResult {
  const match = /^(?:([A-Za-z]{3})\s+)?(-?[\d,]+(?:\.\d+)?)(?:\s+([A-Za-z]{3}))?$/.exec(raw.trim());
  const code = match?.[1] ?? match?.[3];
  if (match === null || code === undefined || (match[1] !== undefined && match[3] !== undefined)) {
    return { ok: false, message: 'Write an amount with a currency code, for example 1500.75 INR' };
  }

  let currency: string;
  try {
    currency = toCurrency(code);
  } catch {
    return { ok: false, message: 'Not a valid currency code' };
  }

  const amount = (match[2] ?? '').replace(/,/g, '');
  const parts = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount);
  if (parts === null) return { ok: false, message: 'Not a valid amount' };

  const exponent = minorUnitExponent(toCurrency(currency));
  const [, sign, whole = '0', fraction = ''] = parts;
  if (fraction.length > exponent) {
    return { ok: false, message: `${currency} has ${exponent} decimal places` };
  }
  const minor =
    BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > 9_999_999_999_999_999_999n) return { ok: false, message: 'That amount is too large' };

  return {
    ok: true,
    value: { amount_minor: (sign === '-' ? -minor : minor).toString(), currency },
  };
}

export function coerceCell(definition: FieldDefinition, raw: string): CellResult {
  const text = raw.trim();
  if (text === '') return { ok: true, blank: true, value: undefined };

  switch (definition.type) {
    case 'text':
    case 'long_text':
    case 'email':
    case 'url':
    case 'user_lookup':
    case 'date':
    case 'datetime':
      return { ok: true, value: text };

    case 'phone':
      return { ok: true, value: normalizePhone(text) };

    case 'number':
    case 'percent': {
      const cleaned = text.replace(/[,\s]/g, '').replace(/%$/, '');
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, message: 'Not a number' };
      return { ok: true, value: Number(cleaned) };
    }

    case 'boolean': {
      const word = text.toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return { ok: false, message: 'Use yes or no' };
    }

    case 'picklist': {
      const matched = matchOption(definition, text);
      return matched === null
        ? { ok: false, message: `"${text}" is not one of the allowed values` }
        : { ok: true, value: matched };
    }

    case 'multi_picklist': {
      const values: string[] = [];
      for (const part of text.split(/[;|]/)) {
        if (part.trim() === '') continue;
        const matched = matchOption(definition, part);
        if (matched === null) {
          return { ok: false, message: `"${part.trim()}" is not one of the allowed values` };
        }
        if (!values.includes(matched)) values.push(matched);
      }
      return { ok: true, value: values };
    }

    case 'currency':
      return parseCurrency(text);
  }
}

/**
 * A stored value as the text a spreadsheet shows.
 *
 * Returns the **raw** text: formula-injection escaping is applied by the
 * writer to every cell, not here, so that no format of value can be added that
 * forgets to ask for it (`toExportCell`, CLAUDE.md §5.11).
 */
export function formatCell(definition: FieldDefinition, value: unknown): string {
  if (value === null || value === undefined) return '';

  if (definition.type === 'boolean') {
    return value === true ? 'true' : value === false ? 'false' : plainText(value);
  }
  if (definition.type === 'multi_picklist') {
    return Array.isArray(value) ? value.map(plainText).join('; ') : plainText(value);
  }
  if (definition.type === 'currency') {
    if (typeof value !== 'object') return plainText(value);
    const { amount_minor: amountMinor, currency } = value as {
      amount_minor?: unknown;
      currency?: unknown;
    };
    if (typeof amountMinor !== 'string' || typeof currency !== 'string') {
      return plainText(value);
    }
    return formatMinor(BigInt(amountMinor), currency);
  }
  return plainText(value);
}

/** `150075n`, `INR` -> `1500.75 INR`. Exact; no floats anywhere. */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const exponent = minorUnitExponent(toCurrency(currency));
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction} ${currency.toUpperCase()}`;
}
