/**
 * Lead rules that belong to no one layer: what counts as a duplicate, and how
 * a lead's fields map onto the records it becomes (ADR-0022, ADR-0023).
 *
 * Pure functions, no I/O, so the web app can reuse them and a test needs no
 * database to pin the rules down.
 */

/** The statuses a lead can be moved between by hand. */
export const OPEN_LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;
export type OpenLeadStatus = (typeof OPEN_LEAD_STATUSES)[number];

/** Every status, including the one only conversion may set. */
export const LEAD_STATUSES = [...OPEN_LEAD_STATUSES, 'converted'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * The cut-off for "this company name is probably the same company".
 *
 * Measured against pg_trgm `similarity()` on realistic pairs rather than
 * chosen by feel: "Rajesh Gold House" against "…Pvt Ltd" scores 0.69, a plural
 * 0.86, a case difference 0.81 — and an unrelated "Zenith Trading" against
 * "Acme Trading", which shares a word, scores 0.40. 0.5 sits between those. A
 * false positive costs a click on "create anyway"; a false negative is a
 * duplicate customer, so the line leans towards asking.
 */
export const COMPANY_NAME_SIMILARITY_THRESHOLD = 0.5;

/** The most matches of one kind a prompt will ever show. */
export const MAX_DUPLICATE_MATCHES = 5;

/**
 * Domains that identify a mail provider, not a company.
 *
 * Matching an account on `gmail.com` would tell a rep that every Gmail lead
 * belongs to whichever account first typed it in. Not exhaustive and not
 * meant to be: a provider missing here produces a spurious prompt, never a
 * wrong merge, because a match is only ever offered.
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zoho.com',
  'gmx.com',
  'mail.com',
]);

/** The part after the last `@`, lowercased, or null when there is none. */
export function emailDomain(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * The company domain an email address implies, or null for a free-mail one.
 * This is what an account is matched on, and what a new account is given.
 */
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const domain = emailDomain(email);
  if (domain === null || FREE_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** Why a record was offered as a duplicate. */
export const DUPLICATE_REASONS = ['email', 'phone', 'domain', 'name'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/**
 * How a lead's standard fields map onto the contact it becomes (ADR-0022).
 *
 * `prop` is the API/row property on each side and `field` the `field_definitions`
 * key permissions are checked against — they differ for snake_case keys and for
 * the one renamed field, the lead's `source`, which is the contact's
 * `lead_source`. Conversion copies exactly these and nothing else, so a field
 * added to leads later is not silently carried into contacts.
 */
export interface LeadFieldMapping {
  readonly lead: { readonly prop: string; readonly field: string };
  readonly contact: { readonly prop: string; readonly field: string };
  readonly required: boolean;
}

export const LEAD_TO_CONTACT_FIELDS: readonly LeadFieldMapping[] = [
  {
    lead: { prop: 'firstName', field: 'first_name' },
    contact: { prop: 'firstName', field: 'first_name' },
    required: false,
  },
  {
    lead: { prop: 'lastName', field: 'last_name' },
    contact: { prop: 'lastName', field: 'last_name' },
    required: true,
  },
  {
    lead: { prop: 'email', field: 'email' },
    contact: { prop: 'email', field: 'email' },
    required: false,
  },
  {
    lead: { prop: 'phone', field: 'phone' },
    contact: { prop: 'phone', field: 'phone' },
    required: false,
  },
  {
    lead: { prop: 'source', field: 'source' },
    contact: { prop: 'leadSource', field: 'lead_source' },
    required: false,
  },
];
