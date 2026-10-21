import { toCurrency } from '../money/index.js';
import {
  isFieldType,
  type FieldType,
  type FieldValidation,
  type PicklistOption,
} from './types.js';

/**
 * The rules for *defining* a custom field (MVP_SPEC M9, ADR-0039).
 *
 * `schema.ts` decides whether a record's **value** is acceptable; this decides
 * whether an administrator's **definition** is. They are separate because the
 * second is the one that can hurt data that already exists: a definition that
 * drops a picklist value, narrows a range below what records hold, or changes a
 * type leaves rows describing something the field no longer is.
 *
 * Pure and dependency-free so the API enforces it and the admin screen can show
 * the same limits without a second copy.
 */

/** Types an administrator may create. `user_lookup` waits for a member picker non-admins can use. */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean',
  'picklist',
  'multi_picklist',
  'email',
  'phone',
  'url',
] as const satisfies readonly FieldType[];

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return isFieldType(value) && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

/** The objects whose fields can be customised (MVP_SPEC M9). */
export const CUSTOMIZABLE_OBJECTS = ['account', 'contact', 'lead', 'deal'] as const;
export type CustomizableObject = (typeof CUSTOMIZABLE_OBJECTS)[number];

export function isCustomizableObject(value: unknown): value is CustomizableObject {
  return typeof value === 'string' && (CUSTOMIZABLE_OBJECTS as readonly string[]).includes(value);
}

export const MAX_CUSTOM_FIELDS_PER_OBJECT = 60;
export const MAX_PICKLIST_OPTIONS = 100;
export const LABEL_MAX_LENGTH = 80;
export const SECTION_MAX_LENGTH = 60;
export const HELP_TEXT_MAX_LENGTH = 280;

export function isPicklistType(type: FieldType): boolean {
  return type === 'picklist' || type === 'multi_picklist';
}

export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

/* -------------------------------------------------------------------------- */
/* Keys and option values                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A label as a snake_case identifier: lowercase ASCII, accents folded, anything
 * else a separator. Never empty, never starting with a digit (a key is a jsonb
 * path and an API property name), at most 40 characters so that a collision
 * suffix still fits within the 63 the database allows.
 */
export function slugify(label: string): string {
  const folded = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const base = folded.length === 0 ? 'field' : folded;
  const letterFirst = /^[a-z]/.test(base) ? base : `f_${base}`;
  return letterFirst.slice(0, 40).replace(/_+$/g, '');
}

/** `base`, or `base_2`, `base_3` … the first one not already taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A picklist value: lowercase letters, digits and underscores. Digits may lead. */
export const OPTION_VALUE_PATTERN = /^[a-z0-9][a-z0-9_]{0,62}$/;

/* -------------------------------------------------------------------------- */
/* Picklist options                                                           */
/* -------------------------------------------------------------------------- */

export interface OptionInput {
  /** Present for an option that already exists; absent for a new one. */
  readonly value?: string | undefined;
  readonly label: string;
  readonly isActive?: boolean | undefined;
}

export type ResolvedOptions =
  | { readonly ok: true; readonly options: readonly PicklistOption[] }
  | { readonly ok: false; readonly issues: readonly DefinitionIssue[] };

/**
 * Turn what an administrator submitted into the stored option list.
 *
 * - An option that already exists is named by its `value`, which never changes;
 *   only its label, order and active flag can. The submission must name **every**
 *   existing value: retiring one is `isActive: false`, because records may hold it.
 * - A new option has no value, and gets one made from its label, unique within the
 *   list. The administrator never types a value, so a typo cannot create two.
 * - Labels are unique ignoring case, or the picker shows two identical rows.
 * - At least one option stays active, or nothing could ever be chosen.
 */
export function resolveOptions(
  existing: readonly PicklistOption[] | undefined,
  incoming: readonly OptionInput[],
): ResolvedOptions {
  const issues: DefinitionIssue[] = [];
  const known = new Map((existing ?? []).map((option) => [option.value, option]));

  if (incoming.length === 0) {
    return { ok: false, issues: [{ path: 'options', message: 'Add at least one option' }] };
  }
  if (incoming.length > MAX_PICKLIST_OPTIONS) {
    return {
      ok: false,
      issues: [
        { path: 'options', message: `A picklist can have at most ${MAX_PICKLIST_OPTIONS} options` },
      ],
    };
  }

  const labels = new Set<string>();
  const taken = new Set<string>(known.keys());
  const seenValues = new Set<string>();
  const resolved: PicklistOption[] = [];

  incoming.forEach((option, index) => {
    const path = `options.${index}`;
    const label = option.label.trim();

    if (label.length === 0 || label.length > LABEL_MAX_LENGTH) {
      issues.push({ path: `${path}.label`, message: `Use 1 to ${LABEL_MAX_LENGTH} characters` });
    }
    const folded = label.toLowerCase();
    if (labels.has(folded)) {
      issues.push({ path: `${path}.label`, message: 'Two options have the same label' });
    }
    labels.add(folded);

    let value = option.value;
    if (value !== undefined) {
      if (!known.has(value)) {
        issues.push({ path: `${path}.value`, message: 'Unknown option' });
      }
      if (seenValues.has(value)) {
        issues.push({ path: `${path}.value`, message: 'This option is listed twice' });
      }
      seenValues.add(value);
    } else {
      const base = slugify(label).replace(/^f_/, '');
      value = uniqueSlug(base.length === 0 ? 'option' : base, taken);
      taken.add(value);
    }

    resolved.push({ value, label, isActive: option.isActive !== false });
  });

  for (const value of known.keys()) {
    if (!seenValues.has(value)) {
      issues.push({
        path: 'options',
        message: 'An option that has been offered cannot be removed; deactivate it instead',
      });
      break;
    }
  }

  if (!resolved.some((option) => option.isActive !== false)) {
    issues.push({ path: 'options', message: 'Keep at least one option active' });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, options: resolved };
}

/* -------------------------------------------------------------------------- */
/* Per-type validation limits                                                 */
/* -------------------------------------------------------------------------- */

/** Which `validation` keys mean something for which type. Everything else is refused. */
const ALLOWED_VALIDATION: Readonly<Record<FieldType, readonly (keyof FieldValidation)[]>> = {
  text: ['minLength', 'maxLength'],
  long_text: ['minLength', 'maxLength'],
  email: ['maxLength'],
  number: ['min', 'max'],
  percent: ['min', 'max'],
  currency: ['allowedCurrencies'],
  phone: [],
  url: [],
  date: [],
  datetime: [],
  boolean: [],
  picklist: [],
  multi_picklist: [],
  user_lookup: [],
};

/** The longest a text value may be made to be: the engine's own ceilings. */
const TEXT_CEILING: Partial<Record<FieldType, number>> = {
  text: 255,
  email: 255,
  long_text: 32_000,
};

const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;

/**
 * Check an administrator's `validation` for one type.
 *
 * `pattern` is never accepted here. The engine can apply one, but a pattern is a
 * program the server runs on every write, and a pathological one (`(a+)+$`) holds
 * a request thread for as long as the input is long. That needs a regex engine
 * with a time bound before it is offered (ADR-0039).
 */
export function validateFieldValidation(
  type: FieldType,
  validation: FieldValidation | undefined,
): DefinitionIssue[] {
  if (validation === undefined) return [];
  const issues: DefinitionIssue[] = [];
  const allowed = ALLOWED_VALIDATION[type];

  for (const key of Object.keys(validation)) {
    if (!(allowed as readonly string[]).includes(key)) {
      issues.push({ path: `validation.${key}`, message: `Not available for ${type} fields` });
    }
  }
  if (issues.length > 0) return issues;

  const ceiling = TEXT_CEILING[type];
  if (validation.minLength !== undefined || validation.maxLength !== undefined) {
    const { minLength, maxLength } = validation;
    const limit = ceiling ?? 255;
    for (const [key, value] of [
      ['minLength', minLength],
      ['maxLength', maxLength],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > limit)) {
        issues.push({ path: `validation.${key}`, message: `Use a whole number from 0 to ${limit}` });
      }
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      issues.push({ path: 'validation.minLength', message: 'The minimum is above the maximum' });
    }
  }

  if (validation.min !== undefined || validation.max !== undefined) {
    for (const key of ['min', 'max'] as const) {
      const value = validation[key];
      if (value !== undefined && !DECIMAL.test(value)) {
        issues.push({ path: `validation.${key}`, message: 'Use a number, such as 0 or 12.5' });
      }
    }
    if (
      validation.min !== undefined &&
      validation.max !== undefined &&
      DECIMAL.test(validation.min) &&
      DECIMAL.test(validation.max) &&
      Number(validation.min) > Number(validation.max)
    ) {
      issues.push({ path: 'validation.min', message: 'The minimum is above the maximum' });
    }
  }

  if (validation.allowedCurrencies !== undefined) {
    const codes = validation.allowedCurrencies;
    if (codes.length > 20) {
      issues.push({ path: 'validation.allowedCurrencies', message: 'Choose at most 20 currencies' });
    }
    for (const code of codes) {
      try {
        toCurrency(code);
      } catch {
        issues.push({
          path: 'validation.allowedCurrencies',
          message: `${code} is not a currency code`,
        });
      }
    }
    if (new Set(codes.map((code) => code.toUpperCase())).size !== codes.length) {
      issues.push({ path: 'validation.allowedCurrencies', message: 'A currency is listed twice' });
    }
  }

  return issues;
}

/** The text-like types, for callers that need to know whether a field holds a string. */
export function isTextLike(type: FieldType): boolean {
  return type === 'text' || type === 'long_text' || type === 'email' || type === 'phone' || type === 'url';
}
