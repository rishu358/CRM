import { z } from 'zod';
import { isPlainDate } from '../dates/index.js';
import { isUuid } from '../ids/index.js';
import { toCurrency } from '../money/index.js';
import type { FieldDefinition, FieldValidation } from './types.js';

/**
 * Zod schemas generated from field metadata (ADR-0004, CLAUDE.md §5.6).
 *
 * This is the only place a custom field's value is validated, so it is the only
 * place that has to be right. Schemas are rebuilt when metadata changes and
 * cached per tenant by the caller.
 */

/** E.164: a leading +, a non-zero country digit, then up to 14 more digits. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/** Generous but bounded: long_text holds notes, not file uploads. */
const DEFAULT_TEXT_MAX = 255;
const DEFAULT_LONG_TEXT_MAX = 32_000;

function applyTextRules(
  schema: z.ZodString,
  validation: FieldValidation | undefined,
  fallbackMax: number,
) {
  let result = schema.max(validation?.maxLength ?? fallbackMax);
  if (validation?.minLength !== undefined) result = result.min(validation.minLength);
  if (validation?.pattern !== undefined) {
    // Anchored so a tenant-supplied pattern cannot match a mere substring.
    result = result.regex(new RegExp(`^(?:${validation.pattern})$`, 'u'));
  }
  return result;
}

function applyNumberRules(schema: z.ZodNumber, validation: FieldValidation | undefined) {
  let result = schema;
  if (validation?.min !== undefined) result = result.min(Number(validation.min));
  if (validation?.max !== undefined) result = result.max(Number(validation.max));
  return result;
}

function activeOptionValues(definition: FieldDefinition): string[] {
  return (definition.options ?? [])
    .filter((option) => option.isActive !== false)
    .map((option) => option.value);
}

/**
 * A currency amount as stored in `custom_fields` jsonb.
 *
 * `amount_minor` is a **decimal string**, not a number: JSON has no integer type
 * beyond 2^53 and no decimal type at all, so a large amount round-tripped as a
 * JSON number would silently lose precision (ADR-0011).
 */
const currencyValueSchema = z.strictObject({
  amount_minor: z.string().regex(/^-?\d{1,19}$/, 'Must be whole minor units as a string'),
  currency: z
    .string()
    .length(3)
    .refine((value) => {
      try {
        toCurrency(value);
        return true;
      } catch {
        return false;
      }
    }, 'Must be an ISO-4217 currency code'),
});

/** Build the schema for one field's value, ignoring whether it is required. */
export function buildFieldValueSchema(definition: FieldDefinition): z.ZodType {
  const v = definition.validation;

  switch (definition.type) {
    case 'text':
      return applyTextRules(z.string().trim(), v, DEFAULT_TEXT_MAX);

    case 'long_text':
      return applyTextRules(z.string(), v, DEFAULT_LONG_TEXT_MAX);

    case 'number':
      return applyNumberRules(z.number().finite(), v);

    case 'percent':
      // Defaults to 0-100 unless the tenant widened it deliberately.
      return applyNumberRules(
        z
          .number()
          .finite()
          .min(Number(v?.min ?? 0))
          .max(Number(v?.max ?? 100)),
        undefined,
      );

    case 'currency': {
      const allowed = v?.allowedCurrencies;
      if (allowed === undefined || allowed.length === 0) return currencyValueSchema;
      const permitted = new Set(allowed.map((code) => code.toUpperCase()));
      return currencyValueSchema.refine(
        (value) => permitted.has(value.currency.toUpperCase()),
        `Currency must be one of: ${[...permitted].join(', ')}`,
      );
    }

    case 'date':
      return z.string().refine(isPlainDate, 'Must be a calendar date as YYYY-MM-DD');

    case 'datetime':
      return z.iso.datetime({ offset: true });

    case 'boolean':
      return z.boolean();

    case 'picklist': {
      const values = activeOptionValues(definition);
      if (values.length === 0) return z.never();
      return z.enum(values as [string, ...string[]]);
    }

    case 'multi_picklist': {
      const values = activeOptionValues(definition);
      if (values.length === 0) return z.array(z.never()).max(0);
      return z
        .array(z.enum(values as [string, ...string[]]))
        .max(values.length)
        .refine((selected) => new Set(selected).size === selected.length, 'Values must be unique');
    }

    case 'email':
      // Lowercased to match the citext column, so comparison is consistent.
      return z
        .email()
        .max(v?.maxLength ?? DEFAULT_TEXT_MAX)
        .transform((value) => value.toLowerCase());

    case 'phone':
      return z.string().regex(E164_PATTERN, 'Must be an E.164 phone number, e.g. +919876543210');

    case 'url':
      // http(s) only: a javascript: or data: URL rendered as a link is an XSS vector,
      // and other schemes are of no use to a CRM.
      return z.url().refine((value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === 'http:' || protocol === 'https:';
        } catch {
          return false;
        }
      }, 'Must be an http or https URL');

    case 'user_lookup':
      // Format only. That the user exists in this tenant is checked by the
      // service against memberships; a UUID here proves nothing about access.
      return z.string().refine(isUuid, 'Must reference a user');
  }
}

/**
 * Build the schema for one field including presence rules.
 *
 * A required field must be present and non-null. An optional one may be omitted
 * or explicitly null — null is how the UI clears a value, and is distinct from
 * "not supplied", which leaves the stored value alone on a PATCH.
 */
export function buildFieldSchema(definition: FieldDefinition): z.ZodType {
  const value = buildFieldValueSchema(definition);
  if (definition.required) return value;
  return value.nullable().optional();
}
