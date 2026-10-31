/**
 * Merge fields in an email's subject and text (ADR-0074).
 *
 * A closed list, filled by the server when the email is queued, from records the sender may read.
 * There is no scripting and no conditional: a name between double braces is replaced by the person's
 * own value as plain text, once, and a value that itself holds braces is not looked at again.
 */

export const EMAIL_MERGE_FIELDS = [
  'contact.first_name',
  'contact.last_name',
  'account.name',
  'deal.name',
  'sender.name',
  'company.name',
] as const;
export type EmailMergeField = (typeof EMAIL_MERGE_FIELDS)[number];

const EMAIL_MERGE_FIELD_SET: ReadonlySet<string> = new Set(EMAIL_MERGE_FIELDS);

export function isEmailMergeField(value: string): value is EmailMergeField {
  return EMAIL_MERGE_FIELD_SET.has(value);
}

/** What each name stands for, for the help beside the message box (the web app passes it through `t`). */
export const EMAIL_MERGE_FIELD_DESCRIPTIONS: Readonly<Record<EmailMergeField, string>> = {
  'contact.first_name': "The person's first name",
  'contact.last_name': "The person's last name",
  'account.name': "The person's company (a lead's company, for a lead)",
  'deal.name': "The deal's name, when you write from a deal",
  'sender.name': 'Your name',
  'company.name': 'Your company’s name',
};

/** A control character: below a space, or DEL. Checked by code, so no pattern has to name them. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Anything between double braces: a known name is filled in, any other is refused rather than sent as typed. */
const BRACED = /\{\{([^{}]*)\}\}/g;

/** The names used between braces, once each, in the order they first appear. */
export function emailMergeFieldsIn(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(BRACED)) {
    const name = (match[1] ?? '').trim();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** The braced names that are not on the list. A text with any of them is not sent and not saved. */
export function unknownEmailMergeFields(text: string): string[] {
  return emailMergeFieldsIn(text).filter((name) => !isEmailMergeField(name));
}

export type EmailMergeValues = Readonly<Partial<Record<EmailMergeField, string>>>;

/** A value as it goes into the text: one line, tidy, never longer than a name can be. */
function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200);
}

/** The known fields in `text` replaced by their values. A field with no value becomes nothing. */
export function renderEmailMergeFields(text: string, values: EmailMergeValues): string {
  return text.replace(BRACED, (whole, raw: string) => {
    const name = raw.trim();
    return isEmailMergeField(name) ? clean(values[name]) : whole;
  });
}

/** The fields `text` uses that have no value for this person, so the screen can say so before sending. */
export function emptyEmailMergeFields(text: string, values: EmailMergeValues): EmailMergeField[] {
  return emailMergeFieldsIn(text)
    .filter(isEmailMergeField)
    .filter((name) => clean(values[name]) === '');
}

export const EMAIL_TEMPLATE_NAME_MAX = 80;
export const EMAIL_TEMPLATES_PER_TENANT_MAX = 100;
export const EMAIL_SIGNATURE_MAX = 500;

export function isValidTemplateName(value: string): boolean {
  return value.length > 0 && value.length <= EMAIL_TEMPLATE_NAME_MAX && !hasControlCharacter(value);
}

export function isValidSignature(value: string): boolean {
  return value.length <= EMAIL_SIGNATURE_MAX && !value.includes('\u0000');
}
