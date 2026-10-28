import { z } from 'zod';
import { isPlainDate } from '../dates/index.js';
import type { FieldDefinition } from '../fields/types.js';
import { HONEYPOT_FIELD, cleanText, normalizePhone, type FormFieldSetting } from './index.js';

/**
 * What a stranger's submission is judged by (ADR-0063 4.2).
 *
 * The schema is **built from the form**, never from the request: only the form's own fields are
 * in it, `.strict()` refuses anything else, and every value has a length cap before it is looked
 * at any further. The result is what the lead is made from; nothing else a request carried gets
 * anywhere near it.
 */

/** The longest value per kind of field. Short on purpose: this is a contact form, not a document store. */
const NAME_MAX = 120;
const COMPANY_MAX = 200;
const EMAIL_MAX = 254;
const TEXT_MAX = 500;
const LONG_TEXT_MAX = 2000;
const URL_MAX = 500;
const NUMBER_LIMIT = 1e15;

const MAX_LENGTH_BY_KEY: Readonly<Record<string, number>> = {
  first_name: NAME_MAX,
  last_name: NAME_MAX,
  company: COMPANY_MAX,
};

export interface SubmissionFormSettings {
  readonly fields: readonly FormFieldSetting[];
  readonly phoneCountryCode: string | null;
}

/** The values of one submission, by lead field key, after cleaning. */
export type SubmissionValues = Record<string, unknown>;

/** What the public route reads off a body besides the form's own fields. */
export interface SubmissionEnvelope {
  readonly consent: true;
  readonly fillToken: string;
  readonly [HONEYPOT_FIELD]?: string | undefined;
}

const REQUIRED = 'Required';
const INVALID = 'Not valid';
const TOO_LONG = 'Too long';

/** One field's value schema. Strings arrive trimmed and cleaned, or fail with a fixed message. */
function valueSchema(definition: FieldDefinition, phoneCountryCode: string | null): z.ZodType {
  const text = (max: number, multiline: boolean) =>
    z
      .string({ error: INVALID })
      .max(max * 2, TOO_LONG)
      .transform((value, ctx) => {
        const cleaned = cleanText(value, { multiline });
        if (cleaned === null) {
          ctx.addIssue({ code: 'custom', message: INVALID });
          return z.NEVER;
        }
        if (cleaned.length > max) {
          ctx.addIssue({ code: 'custom', message: TOO_LONG });
          return z.NEVER;
        }
        return cleaned;
      });

  switch (definition.type) {
    case 'text':
      return text(MAX_LENGTH_BY_KEY[definition.key] ?? TEXT_MAX, false);

    case 'long_text':
      return text(LONG_TEXT_MAX, true);

    case 'email':
      return z
        .string({ error: INVALID })
        .max(EMAIL_MAX * 2, TOO_LONG)
        .transform((value, ctx) => {
          const cleaned = cleanText(value, { multiline: false });
          const lowered = cleaned?.toLowerCase() ?? null;
          if (
            lowered === null ||
            lowered.length > EMAIL_MAX ||
            !z.email().safeParse(lowered).success ||
            !/@[^@]+\.[^@.]{2,}$/.test(lowered)
          ) {
            ctx.addIssue({ code: 'custom', message: INVALID });
            return z.NEVER;
          }
          return lowered;
        });

    case 'phone':
      return z
        .string({ error: INVALID })
        .max(60, TOO_LONG)
        .transform((value, ctx) => {
          const normalised = normalizePhone(value, phoneCountryCode);
          if (normalised === null) {
            ctx.addIssue({ code: 'custom', message: INVALID });
            return z.NEVER;
          }
          return normalised;
        });

    case 'url':
      return text(URL_MAX, false).refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.username === '' &&
            url.password === ''
          );
        } catch {
          return false;
        }
      }, INVALID);

    case 'number':
      return z
        .number({ error: INVALID })
        .finite(INVALID)
        .min(-NUMBER_LIMIT, INVALID)
        .max(NUMBER_LIMIT, INVALID);

    case 'date':
      return z.string({ error: INVALID }).refine(isPlainDate, INVALID);

    case 'boolean':
      return z.boolean({ error: INVALID });

    case 'picklist': {
      const values = (definition.options ?? [])
        .filter((option) => option.isActive !== false)
        .map((option) => option.value);
      return values.length === 0
        ? z.never({ error: INVALID })
        : z.enum(values as [string, ...string[]], { error: INVALID });
    }

    case 'multi_picklist': {
      const values = (definition.options ?? [])
        .filter((option) => option.isActive !== false)
        .map((option) => option.value);
      if (values.length === 0) return z.array(z.never()).max(0);
      return z
        .array(z.enum(values as [string, ...string[]], { error: INVALID }), { error: INVALID })
        .max(values.length, TOO_LONG)
        .refine((selected) => new Set(selected).size === selected.length, INVALID);
    }

    case 'currency':
    case 'datetime':
    case 'percent':
    case 'user_lookup':
      // A type a form cannot offer. `checkFormFields` keeps it from being saved; this keeps it from
      // being accepted if a stored form ever holds one.
      return z.never({ error: INVALID });
  }
}

/**
 * The strict schema for one form.
 *
 * Optional fields may be left out or sent empty (an HTML form sends `""`); a required field may
 * not. Unknown keys, a missing consent, and a missing fill token are failures. The reachability
 * rule (an email or a phone, if the form asks for either) is checked on the whole object.
 */
export function buildSubmissionSchema(
  form: SubmissionFormSettings,
  definitions: readonly FieldDefinition[],
): z.ZodType<SubmissionValues & SubmissionEnvelope> {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const shape: Record<string, z.ZodType> = {
    consent: z.literal(true, { error: REQUIRED }),
    fillToken: z.string({ error: REQUIRED }).max(200, TOO_LONG),
    // Looks like a field and is hidden from people. A body with it filled never reaches this
    // schema (the route answers as if it had worked), so here it is absent or empty.
    [HONEYPOT_FIELD]: z.string().max(0).optional(),
  };

  const reachable: string[] = [];
  for (const setting of form.fields) {
    const definition = byKey.get(setting.key);
    if (definition === undefined) continue;
    if (setting.key === 'email' || setting.key === 'phone') reachable.push(setting.key);

    const value = valueSchema(definition, form.phoneCountryCode);
    shape[setting.key] = setting.required
      ? value
      : z.preprocess(
          (raw) => (typeof raw === 'string' && raw.trim() === '' ? undefined : raw),
          value.optional(),
        );
  }

  return z.strictObject(shape).superRefine((values, ctx) => {
    if (reachable.length === 0) return;
    const record = values as Record<string, unknown>;
    if (reachable.some((key) => record[key] !== undefined)) return;
    for (const key of reachable) {
      ctx.addIssue({ code: 'custom', path: [key], message: REQUIRED });
    }
  }) as unknown as z.ZodType<SubmissionValues & SubmissionEnvelope>;
}

export interface PublicIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Turn a Zod failure into what may be shown to a stranger: the form's own field names and one of a
 * few fixed sentences. Never a submitted value, and never an unknown key's name (it is whatever
 * the sender typed, and could be anything).
 */
export function toPublicIssues(error: z.ZodError, allowedKeys: readonly string[]): PublicIssue[] {
  const allowed = new Set([...allowedKeys, 'consent']);
  const issues: PublicIssue[] = [];
  const seen = new Set<string>();

  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      if (!seen.has('*')) issues.push({ path: '', message: 'That is not a field of this form' });
      seen.add('*');
      continue;
    }
    const first = issue.path[0];
    const path = typeof first === 'string' && allowed.has(first) ? first : '';
    const message = [REQUIRED, INVALID, TOO_LONG].includes(issue.message) ? issue.message : INVALID;
    const id = `${path}:${message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push({ path, message });
  }
  return issues;
}

/** The names the lead's own columns have, by lead field key. */
export const LEAD_COLUMN_BY_FIELD_KEY: Readonly<Record<string, string>> = {
  first_name: 'firstName',
  last_name: 'lastName',
  company: 'company',
  email: 'email',
  phone: 'phone',
};

/**
 * Split cleaned values into the lead's standard columns and its custom fields.
 *
 * Only keys the form asks for are in `values` (the schema is strict), and only the five standard
 * columns map to a column; everything else is a custom field by key.
 */
export function splitSubmission(
  values: SubmissionValues,
  fields: readonly FormFieldSetting[],
): {
  readonly standard: Record<string, string>;
  readonly customFields: Record<string, unknown>;
} {
  const standard: Record<string, string> = {};
  const customFields: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null) continue;
    const column = LEAD_COLUMN_BY_FIELD_KEY[field.key];
    if (column !== undefined) standard[column] = value as string;
    else customFields[field.key] = value;
  }
  return { standard, customFields };
}
