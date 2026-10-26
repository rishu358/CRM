import { fromMajorString } from '@crm/core';
import type { FieldDefinitionView } from '@crm/contracts';
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  type ViewerPreferences,
} from './format';
import type { TranslationKey } from './i18n';
import { CURRENCIES, toMajorString } from './money-input';

/**
 * A custom field's value, as a form holds it and as the API takes it
 * (MVP_SPEC M9, ADR-0039).
 *
 * The API stores JSON of a shape per type: a number is a JSON number, a currency is
 * `{ amount_minor: "<digits>", currency }`, a date is `YYYY-MM-DD`, a picklist is its
 * value and a multi-picklist an array of values. A form cannot hold those directly —
 * an input has a string in it — so every type has a **draft** shape and two
 * conversions, in this file and nowhere else, so what a box shows and what is sent
 * cannot drift apart.
 */

export type MoneyDraft = { readonly amount: string; readonly currency: string };
export type Draft = string | readonly string[] | MoneyDraft;

export type Converted =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: TranslationKey };

const DEFAULT_CURRENCY = 'INR';
const NUMBER = /^-?\d+(\.\d+)?$/;

type Definition = Pick<FieldDefinitionView, 'type'>;

function isMoney(value: unknown): value is { amount_minor: string; currency: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { amount_minor?: unknown }).amount_minor === 'string' &&
    typeof (value as { currency?: unknown }).currency === 'string'
  );
}

/** An ISO instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input wants, in local time. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The empty draft for a type: what a new record's box starts as. */
export function emptyDraft(definition: Definition): Draft {
  if (definition.type === 'multi_picklist') return [];
  if (definition.type === 'currency') return { amount: '', currency: DEFAULT_CURRENCY };
  return '';
}

/** What goes in the box for a stored value. */
export function draftFromValue(definition: Definition, value: unknown): Draft {
  if (value === null || value === undefined) return emptyDraft(definition);

  switch (definition.type) {
    case 'multi_picklist':
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    case 'currency':
      return isMoney(value)
        ? { amount: toMajorString(value.amount_minor, value.currency), currency: value.currency }
        : emptyDraft(definition);
    case 'boolean':
      return value === true ? 'true' : value === false ? 'false' : '';
    case 'datetime':
      return typeof value === 'string' ? toLocalInput(value) : '';
    case 'number':
    case 'percent':
      return typeof value === 'number' ? String(value) : '';
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
    case 'date':
    case 'picklist':
    case 'user_lookup':
      return typeof value === 'string' ? value : '';
  }
}

/** True when the box holds nothing, so the field is cleared (and a required one is missing). */
export function isEmptyDraft(definition: Definition, draft: Draft): boolean {
  if (definition.type === 'multi_picklist') return (draft as readonly string[]).length === 0;
  if (definition.type === 'currency') return (draft as MoneyDraft).amount.trim() === '';
  return (draft as string).trim() === '';
}

/**
 * What the box holds, as the value to send. An empty box is `null`, which is how the
 * API clears a value; anything unparseable is an error to show next to the box, never
 * a value quietly altered.
 */
export function valueFromDraft(definition: Definition, draft: Draft): Converted {
  if (isEmptyDraft(definition, draft)) return { ok: true, value: null };

  switch (definition.type) {
    case 'multi_picklist':
      return { ok: true, value: [...(draft as readonly string[])] };

    case 'currency': {
      const { amount, currency } = draft as MoneyDraft;
      try {
        const parsed = fromMajorString(amount, currency);
        return {
          ok: true,
          value: { amount_minor: parsed.amountMinor.toString(), currency: parsed.currency },
        };
      } catch {
        return { ok: false, error: 'error.amount' };
      }
    }

    case 'number':
    case 'percent': {
      const text = (draft as string).trim();
      if (!NUMBER.test(text)) return { ok: false, error: 'customFields.error.number' };
      return { ok: true, value: Number(text) };
    }

    case 'boolean':
      return { ok: true, value: (draft as string) === 'true' };

    case 'datetime': {
      const date = new Date(draft as string);
      return Number.isNaN(date.getTime())
        ? { ok: false, error: 'customFields.error.date' }
        : { ok: true, value: date.toISOString() };
    }

    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
    case 'date':
    case 'picklist':
    case 'user_lookup':
      return { ok: true, value: (draft as string).trim() };
  }
}

/** A stored value as words, for a record page that is not being edited. */
export function displayValue(
  definition: Pick<FieldDefinitionView, 'type' | 'options'>,
  value: unknown,
  preferences: ViewerPreferences,
  labels: { yes: string; no: string },
): string {
  if (value === null || value === undefined) return '';

  const optionLabel = (stored: unknown): string =>
    definition.options?.find((option) => option.value === stored)?.label ?? String(stored);

  switch (definition.type) {
    case 'picklist':
      return optionLabel(value);
    case 'multi_picklist':
      return Array.isArray(value) ? value.map(optionLabel).join(', ') : '';
    case 'boolean':
      return value === true ? labels.yes : value === false ? labels.no : '';
    case 'currency':
      return isMoney(value) ? formatMoney(value.amount_minor, value.currency, preferences) : '';
    case 'date':
      return typeof value === 'string' ? formatDate(value, preferences) : '';
    case 'datetime':
      return typeof value === 'string' ? formatDateTime(value, preferences) : '';
    case 'number':
      return typeof value === 'number'
        ? new Intl.NumberFormat(preferences.locale, { maximumFractionDigits: 6 }).format(value)
        : '';
    case 'percent':
      return typeof value === 'number' ? `${formatCount(value, preferences)}%` : '';
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
    case 'user_lookup':
      return typeof value === 'string' ? value : '';
  }
}

/** Only a web address is ever rendered as a link: a stored `javascript:` is text. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export { CURRENCIES };
