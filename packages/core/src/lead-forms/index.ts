/**
 * The rules of a website lead form (ADR-0063).
 *
 * Pure: no database, no clock, no randomness, so every rule here is a unit test and the screen, the
 * API and the public page ask the same functions. Everything a stranger on the internet can send
 * is judged by what is in this file and in `submission.ts`, which is why it is deliberately short
 * and has no cleverness in it.
 */

import type { FieldDefinition, FieldType } from '../fields/types.js';

/** What a lead made by a form is marked with. A constant: the visitor never chooses it. */
export const WEB_FORM_SOURCE = 'web_form';

/** The most fields one form may ask for. */
export const MAX_FORM_FIELDS = 25;
export const FORM_NAME_MAX_LENGTH = 120;
export const FORM_LABEL_MAX_LENGTH = 80;
export const FORM_HELP_TEXT_MAX_LENGTH = 200;
export const CONSENT_TEXT_MIN_LENGTH = 20;
export const CONSENT_TEXT_MAX_LENGTH = 1000;
export const SUCCESS_MESSAGE_MAX_LENGTH = 500;
export const FORM_URL_MAX_LENGTH = 500;
export const MAX_ALLOWED_ORIGINS = 10;

/** Request body ceiling on the public routes, in bytes (ADR-0063 4.1). */
export const PUBLIC_FORM_BODY_MAX_BYTES = 16 * 1024;

/** The fill token is valid from this long after the page was drawn... */
export const FILL_TOKEN_MIN_AGE_SECONDS = 3;
/** ...until this long after. A page left open for a day asks to be reloaded. */
export const FILL_TOKEN_MAX_AGE_SECONDS = 4 * 60 * 60;

/** The honeypot's name. It is meant to look worth filling in; the page hides it from people. */
export const HONEYPOT_FIELD = 'website_url';

/**
 * A form key: a prefix, then 32 random bytes in base64url. The shape is checked before anything
 * else, so a malformed value never reaches a counter or the database.
 */
export const FORM_KEY_PATTERN = /^lfk_[A-Za-z0-9_-]{43}$/;

export function isFormKeyShape(value: unknown): value is string {
  return typeof value === 'string' && FORM_KEY_PATTERN.test(value);
}

/**
 * The system lead fields a form may ask for. Every other system field is the CRM's own business
 * (`status`, `source`, `owner_id`), and the visitor must never be able to set it.
 */
export const FORM_SYSTEM_FIELD_KEYS: readonly string[] = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
];

/**
 * The types a form may offer. Rich text is not here (ADR-0024's sanitiser is not for the public),
 * nor are currency (a shape a visitor cannot type), a user lookup or anything a visitor must not set.
 */
export const FORM_FIELD_TYPES: readonly FieldType[] = [
  'text',
  'long_text',
  'number',
  'date',
  'boolean',
  'picklist',
  'multi_picklist',
  'email',
  'phone',
  'url',
];

const FORM_FIELD_TYPE_SET: ReadonlySet<string> = new Set(FORM_FIELD_TYPES);

/** One field of a form, as stored. */
export interface FormFieldSetting {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly helpText?: string | undefined;
}

/** Can this lead field be put on a form at all? (Not: is it on one.) */
export function isFormOfferable(definition: FieldDefinition): boolean {
  if (!definition.isActive) return false;
  if (!FORM_FIELD_TYPE_SET.has(definition.type)) return false;
  if (definition.isSystem) return FORM_SYSTEM_FIELD_KEYS.includes(definition.key);
  return true;
}

/** The lead fields a form builder may choose from, in field order. */
export function offerableFormFields(definitions: readonly FieldDefinition[]): FieldDefinition[] {
  return definitions
    .filter(isFormOfferable)
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

export interface FormDefinitionIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Is this list of fields a form that can work?
 *
 * Every key must be a lead field a form may offer, once; the surname must be there and required (a
 * lead needs one, ADR-0022); and a way to reach the person must be there (an email or a phone), so
 * no lead arrives that nobody can answer.
 */
export function checkFormFields(
  fields: readonly FormFieldSetting[],
  definitions: readonly FieldDefinition[],
): FormDefinitionIssue[] {
  const issues: FormDefinitionIssue[] = [];
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));

  if (fields.length > MAX_FORM_FIELDS) {
    issues.push({ path: 'fields', message: `A form has at most ${MAX_FORM_FIELDS} fields` });
  }

  const seen = new Set<string>();
  fields.forEach((field, index) => {
    const path = `fields.${index}.key`;
    if (seen.has(field.key)) {
      issues.push({ path, message: 'A field can be on a form once' });
      return;
    }
    seen.add(field.key);

    const definition = byKey.get(field.key);
    if (definition === undefined || !isFormOfferable(definition)) {
      issues.push({ path, message: 'That field cannot be put on a form' });
    }
  });

  const surname = fields.find((field) => field.key === 'last_name');
  if (surname === undefined || !surname.required) {
    issues.push({ path: 'fields', message: 'A form must ask for the last name, and require it' });
  }

  // A field this workspace requires on every lead has to be asked for, or no submission could ever
  // be saved and the visitor would be refused for something the page never showed them.
  for (const definition of definitions) {
    if (!definition.isActive || !definition.required || definition.isSystem) continue;
    const asked = fields.find((field) => field.key === definition.key);
    if (asked === undefined || !asked.required) {
      issues.push({
        path: 'fields',
        message: `This workspace requires "${definition.label}" on every lead, so the form must ask for it and require it`,
      });
    }
  }

  const reachable = fields.some((field) => field.key === 'email' || field.key === 'phone');
  if (!reachable) {
    issues.push({ path: 'fields', message: 'A form must ask for an email or a phone number' });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * The origin a pasted address names, or `null` if it is not one a form may allow.
 *
 * https only, a real host name (at least one dot, not an IP address), no path, query, fragment or
 * credentials, and no wildcard (a wildcard would let anyone who can host a page under the domain
 * frame the form). `allowLocal` admits `http://localhost` and `http://127.0.0.1` for development.
 */
export function normalizeOrigin(
  value: string,
  options: { allowLocal?: boolean } = {},
): string | null {
  const text = value.trim();
  if (text.length === 0 || text.length > 200 || /[\s*\\]/.test(text)) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return null;
  if (url.pathname !== '/' || (text.endsWith('/') && text.length > url.origin.length + 1))
    return null;

  if (url.protocol === 'http:') {
    if (options.allowLocal !== true || !LOCAL_HOSTS.has(url.hostname)) return null;
    return url.origin;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname;
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    host.includes(':')
  ) {
    return null;
  }
  return url.origin;
}

export function normalizeOrigins(
  values: readonly string[],
  options: { allowLocal?: boolean } = {},
): { origins: string[]; invalid: number[] } {
  const origins: string[] = [];
  const invalid: number[] = [];
  values.forEach((value, index) => {
    const origin = normalizeOrigin(value, options);
    if (origin === null) invalid.push(index);
    else if (!origins.includes(origin)) origins.push(origin);
  });
  return { origins, invalid };
}

/**
 * Is this address one a form may send a visitor to after a submission?
 *
 * https, and on one of the form's own allowed origins: the target is set by the administrator and
 * never read from a request, and it can only be a site the company has already named as its own.
 */
export function isAllowedRedirect(url: string, allowedOrigins: readonly string[]): boolean {
  if (url.length > FORM_URL_MAX_LENGTH || /[\s\\]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      allowedOrigins.includes(parsed.origin)
    );
  } catch {
    return false;
  }
}

/** A privacy-notice link: https, no credentials, no whitespace. */
export function isHttpsUrl(url: string): boolean {
  if (url.length > FORM_URL_MAX_LENGTH || /[\s\\]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// What a visitor typed
// ---------------------------------------------------------------------------

// Control characters other than tab and newline, DEL, and the bidirectional overrides and isolates
// that make text read differently from how it is stored.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

/**
 * Text a visitor typed, made safe to store, or `null` if it must be refused.
 *
 * Nothing is stripped and nothing is "sanitised": a visitor who types `<b>` gets `<b>` stored as
 * text, and every place that shows it escapes it (ADR-0063 4.2). What is refused is what has no
 * business in a name or a message: control characters, bidirectional overrides and text that is
 * not well-formed Unicode (a lone surrogate). Normalised to NFC so one visible string is one
 * stored string, and so duplicate detection compares like with like.
 */
export function cleanText(value: string, options: { multiline: boolean }): string | null {
  if (!isWellFormed(value)) return null;
  const normalised = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (FORBIDDEN_CHARACTERS.test(normalised)) return null;
  if (!options.multiline && /[\n\t]/.test(normalised)) {
    // A tab or a line break pasted into a one-line field is a space to the person who did it.
    return normalised.replace(/[\n\t]+/g, ' ').trim();
  }
  return normalised.trim();
}

/** `String.prototype.isWellFormed` without relying on the runtime having it. */
function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const E164 = /^\+[1-9]\d{1,14}$/;
const INDIA_MOBILE = /^[6-9]\d{9}$/;

/**
 * A phone number as a visitor types it, in E.164, or `null` if it is not a number.
 *
 * Spaces, dashes, dots and brackets are ignored; `00` means `+`; a leading trunk `0` is dropped; a
 * number with no `+` gets the form's `countryCode`. India (`91`) is judged more tightly: a national
 * number is ten digits starting 6 to 9 (a mobile; a landline-only company asks for an email too),
 * which is what keeps `1234567890` out. Other countries get the E.164 length rules only. No library: a full per-country table is a dependency to be asked
 * for (CLAUDE.md §11.4), and this is the whole of what a lead needs.
 */
export function normalizePhone(input: string, countryCode: string | null): string | null {
  const stripped = input.trim().replace(/[\s().-]/g, '');
  if (stripped.length === 0 || stripped.length > 24 || !/^\+?\d+$/.test(stripped)) return null;

  let digits: string;
  if (stripped.startsWith('+')) {
    digits = stripped.slice(1);
  } else if (stripped.startsWith('00')) {
    digits = stripped.slice(2);
  } else {
    if (countryCode === null || !/^[1-9]\d{0,3}$/.test(countryCode)) return null;
    const national = stripped.startsWith('0') ? stripped.slice(1) : stripped;
    // Typed with the country code already in front ("919876543210") and no plus.
    digits =
      countryCode === '91' && national.length === 12 && national.startsWith('91')
        ? national
        : `${countryCode}${national}`;
  }

  const result = `+${digits}`;
  if (!E164.test(result)) return null;
  if (
    result.startsWith('+91') &&
    !INDIA_MOBILE.test(result.slice(3)) &&
    !/^\d{10,11}$/.test(result.slice(3))
  ) {
    return null;
  }
  if (result.startsWith('+91') && !INDIA_MOBILE.test(result.slice(3))) return null;
  return result;
}

/** The region of a locale such as `en-IN`, as a calling code, for pre-filling the editor. */
export function callingCodeForLocale(locale: string): string | null {
  const region = locale.split('-')[1]?.toUpperCase();
  return region !== undefined && region in CALLING_CODES ? (CALLING_CODES[region] ?? null) : null;
}

const CALLING_CODES: Readonly<Record<string, string>> = {
  IN: '91',
  US: '1',
  GB: '44',
  AE: '971',
  SG: '65',
  AU: '61',
};

export * from './submission.js';
