import type { ImportableObjectType } from './targets.js';

/**
 * Where a file came from, and what its column headings then probably mean (ADR-0072).
 *
 * A business moving in brings a file from somewhere: Zoho CRM's export, or a spreadsheet somebody built.
 * Mapping twenty columns by hand on the first day is the part people give up on, so the mapping screen
 * can *suggest* a mapping from the headings. It is a suggestion in the strictest sense: every column is
 * still a choice the person sees and can change, nothing is imported until they press Start, and the
 * server validates the result like any other mapping. A heading that is not recognised is simply left
 * unmapped, and a suggestion for a target the person may not write is never made.
 *
 * ## Where the Zoho names come from
 *
 * Only from Zoho's own public help pages ("Standard fields" for Accounts, Contacts, Leads and Deals,
 * read on 2026-10-28), and nothing reverse-engineered from a real export. Those pages give a module's
 * **field labels**, which is also what an export's heading row uses for standard fields. Two kinds of
 * heading below are **UNVERIFIED**: the system columns an export adds (`Record Id`, `Created Time`,
 * `Closed Time`), which the help pages for standard fields do not list. They are marked in the code and
 * in `UNVERIFIED_ZOHO_HEADINGS`; if a real export words them differently they are simply not
 * recognised and the person picks the column by hand.
 *
 * Zoho values are not translated. A Zoho stage, lead status or lead source that this workspace does
 * not have is refused row by row with a message that names it, exactly as a hand-made file would be;
 * and `Contact Name` on a Zoho deal is a *name* where this importer wants an e-mail address, so it is
 * deliberately not suggested (a wrong suggestion would fail every row).
 */

export type ImportTemplateId = 'zoho' | 'generic';

export const IMPORT_TEMPLATE_IDS: readonly ImportTemplateId[] = ['zoho', 'generic'];

/** "Last Name", "last_name" and "LASTNAME" are the same heading. */
export function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type Aliases = Readonly<Record<ImportableObjectType, Readonly<Record<string, string>>>>;

/** Build an alias table from `heading -> key` pairs, normalising each heading once. */
function aliases(
  entries: Record<ImportableObjectType, readonly (readonly [string, string])[]>,
): Aliases {
  const table = {} as Record<ImportableObjectType, Record<string, string>>;
  for (const [objectType, pairs] of Object.entries(entries) as [
    ImportableObjectType,
    readonly (readonly [string, string])[],
  ][]) {
    table[objectType] = Object.fromEntries(
      pairs.map(([heading, key]) => [normalizeHeading(heading), key]),
    );
  }
  return table;
}

/**
 * Zoho CRM's standard field labels, from its public "Standard fields" help pages, to this product's
 * targets. Each object's own Owner label differs (`Contact Owner`, `Account Owner`, ...).
 */
const ZOHO = aliases({
  contact: [
    ['Contact Owner', 'owner_id'],
    ['First Name', 'first_name'],
    ['Last Name', 'last_name'],
    ['Account Name', 'account_id'],
    ['Lead Source', 'lead_source'],
    ['Title', 'title'],
    ['Email', 'email'],
    ['Phone', 'phone'],
    // UNVERIFIED (not on the standard-fields pages): the system columns of an export.
    ['Created Time', 'created_at'],
  ],
  account: [
    ['Account Name', 'name'],
    ['Account Owner', 'owner_id'],
    ['Website', 'website'],
    ['Industry', 'industry'],
    ['Phone', 'phone'],
    ['Employees', 'employee_count'],
    // UNVERIFIED: the system column of an export.
    ['Created Time', 'created_at'],
  ],
  lead: [
    ['Lead Owner', 'owner_id'],
    ['First Name', 'first_name'],
    ['Last Name', 'last_name'],
    ['Company', 'company'],
    ['Email', 'email'],
    ['Phone', 'phone'],
    ['Lead Source', 'source'],
    // UNVERIFIED: the system column of an export.
    ['Created Time', 'created_at'],
  ],
  deal: [
    ['Deal Owner', 'owner_id'],
    ['Deal Name', 'name'],
    ['Account Name', 'account_id'],
    ['Amount', 'amount'],
    ['Closing Date', 'expected_close_date'],
    ['Stage', 'stage_id'],
    ['Probability', 'probability'],
    // `Contact Name` is deliberately absent: it is a name, and this importer wants an e-mail address.
    // UNVERIFIED: the system columns of an export. `Record Id` is Zoho's own id for the deal, which is
    // exactly what makes importing the same export twice exact.
    ['Record Id', 'external_id'],
    ['Created Time', 'created_at'],
    ['Closed Time', 'closed_at'],
  ],
});

/** Headings that are in `ZOHO` but not on Zoho's standard-fields help pages. */
export const UNVERIFIED_ZOHO_HEADINGS: readonly string[] = [
  'Record Id',
  'Created Time',
  'Closed Time',
];

/**
 * The headings people give a column in a spreadsheet they made themselves. Not a standard of any
 * kind: a list of the common ways to say each thing, so a tidy file maps without help.
 */
const GENERIC = aliases({
  contact: [
    ['First name', 'first_name'],
    ['Given name', 'first_name'],
    ['Last name', 'last_name'],
    ['Surname', 'last_name'],
    ['Family name', 'last_name'],
    ['Email address', 'email'],
    ['E-mail', 'email'],
    ['Mobile', 'phone'],
    ['Phone number', 'phone'],
    ['WhatsApp number', 'whatsapp'],
    ['Job title', 'title'],
    ['Designation', 'title'],
    ['Source', 'lead_source'],
    // `Company` is not suggested for the account link: it is usually free text, and a company that is
    // not yet an account would fail every row. A heading that says `Account` means it.
    ['Account', 'account_id'],
    ['Account name', 'account_id'],
    ['Owner', 'owner_id'],
    ['Assigned to', 'owner_id'],
    ['Created', 'created_at'],
    ['Created date', 'created_at'],
    ['Date created', 'created_at'],
  ],
  account: [
    ['Account name', 'name'],
    ['Company', 'name'],
    ['Company name', 'name'],
    ['Organisation', 'name'],
    ['Organization', 'name'],
    ['Web site', 'website'],
    ['URL', 'website'],
    ['Email address', 'email'],
    ['E-mail', 'email'],
    ['Phone number', 'phone'],
    ['GST number', 'gstin'],
    ['GST', 'gstin'],
    ['Employees', 'employee_count'],
    ['Number of employees', 'employee_count'],
    ['Owner', 'owner_id'],
    ['Assigned to', 'owner_id'],
    ['Created', 'created_at'],
    ['Created date', 'created_at'],
    ['Date created', 'created_at'],
  ],
  lead: [
    ['First name', 'first_name'],
    ['Last name', 'last_name'],
    ['Surname', 'last_name'],
    ['Company name', 'company'],
    ['Organisation', 'company'],
    ['Organization', 'company'],
    ['Email address', 'email'],
    ['E-mail', 'email'],
    ['Phone number', 'phone'],
    ['Mobile', 'phone'],
    ['Lead source', 'source'],
    ['Source', 'source'],
    ['Lead status', 'status'],
    ['Owner', 'owner_id'],
    ['Assigned to', 'owner_id'],
    ['Created', 'created_at'],
    ['Created date', 'created_at'],
    ['Date created', 'created_at'],
  ],
  deal: [
    ['Deal name', 'name'],
    ['Opportunity', 'name'],
    ['Opportunity name', 'name'],
    ['Value', 'amount'],
    ['Deal value', 'amount'],
    ['Pipeline', 'pipeline_id'],
    ['Deal stage', 'stage_id'],
    ['Stage', 'stage_id'],
    ['Account', 'account_id'],
    ['Account name', 'account_id'],
    ['Contact email', 'primary_contact_id'],
    ['Owner', 'owner_id'],
    ['Assigned to', 'owner_id'],
    ['Expected close date', 'expected_close_date'],
    ['Close date', 'expected_close_date'],
    ['Closing date', 'expected_close_date'],
    ['Lost reason', 'lost_reason'],
    ['Reason lost', 'lost_reason'],
    ['ID', 'external_id'],
    ['Deal ID', 'external_id'],
    ['Reference', 'external_id'],
    ['Created', 'created_at'],
    ['Created date', 'created_at'],
    ['Date created', 'created_at'],
    ['Closed date', 'closed_at'],
    ['Date closed', 'closed_at'],
  ],
});

const TEMPLATES: Readonly<Record<ImportTemplateId, Aliases>> = { zoho: ZOHO, generic: GENERIC };

/**
 * Which template a file looks like it came from. Zoho labels each module's owner after the module
 * (`Contact Owner`, `Deal Name`), which a hand-made spreadsheet rarely does, so two or more of
 * those distinctive headings is taken as Zoho. Anything else is a generic spreadsheet. The person
 * can override the guess, which is why it is a guess.
 */
const ZOHO_TELLS: readonly string[] = [
  'contactowner',
  'accountowner',
  'leadowner',
  'dealowner',
  'dealname',
  'accountname',
  'recordid',
  'closingdate',
  'leadstatus',
  'asstphone',
];

export function detectTemplate(headings: readonly string[]): ImportTemplateId {
  const normalized = new Set(headings.map(normalizeHeading));
  const hits = ZOHO_TELLS.filter((tell) => normalized.has(tell)).length;
  return hits >= 2 ? 'zoho' : 'generic';
}

export interface SuggestableTarget {
  readonly key: string;
  readonly label: string;
}

/**
 * Suggest a target for each column, as `column index -> target key`.
 *
 * In order of confidence, for each heading: a heading that **is** a target's own label or key (what
 * the mapping screen always did, so a file that mapped before maps the same way), then the template's
 * alias. A target is suggested once, for the first column that claims it, and only if the person is
 * offered it: a template cannot suggest a column the server would refuse.
 */
export function suggestMapping(
  objectType: ImportableObjectType,
  headings: readonly string[],
  targets: readonly SuggestableTarget[],
  template: ImportTemplateId,
): Record<number, string> {
  const offered = new Set(targets.map((target) => target.key));
  const aliasesFor = TEMPLATES[template][objectType];
  const suggested: Record<number, string> = {};
  const used = new Set<string>();

  headings.forEach((heading, index) => {
    const wanted = normalizeHeading(heading);
    if (wanted === '') return;

    const own = targets.find(
      (target) =>
        !used.has(target.key) &&
        (normalizeHeading(target.label) === wanted || normalizeHeading(target.key) === wanted),
    );
    const key = own?.key ?? aliasesFor[wanted];
    if (key === undefined || used.has(key) || !offered.has(key)) return;
    suggested[index] = key;
    used.add(key);
  });
  return suggested;
}

/**
 * The headings of a blank spreadsheet to start from, for a person with no file yet or a file that
 * needs reshaping. The friendly names of the generic template, for the targets this person is offered.
 */
const TEMPLATE_HEADINGS: Readonly<
  Record<ImportableObjectType, readonly (readonly [string, string])[]>
> = {
  contact: [
    ['First name', 'first_name'],
    ['Last name', 'last_name'],
    ['Email address', 'email'],
    ['Phone number', 'phone'],
    ['WhatsApp number', 'whatsapp'],
    ['Job title', 'title'],
    ['Source', 'lead_source'],
    ['Account', 'account_id'],
    ['Owner', 'owner_id'],
    ['Created date', 'created_at'],
  ],
  account: [
    ['Account name', 'name'],
    ['Website', 'website'],
    ['Industry', 'industry'],
    ['Phone number', 'phone'],
    ['Email address', 'email'],
    ['GST number', 'gstin'],
    ['Number of employees', 'employee_count'],
    ['Owner', 'owner_id'],
    ['Created date', 'created_at'],
  ],
  lead: [
    ['First name', 'first_name'],
    ['Last name', 'last_name'],
    ['Company name', 'company'],
    ['Email address', 'email'],
    ['Phone number', 'phone'],
    ['Source', 'source'],
    ['Lead status', 'status'],
    ['Owner', 'owner_id'],
    ['Created date', 'created_at'],
  ],
  deal: [
    ['Deal name', 'name'],
    ['Amount', 'amount'],
    ['Pipeline', 'pipeline_id'],
    ['Deal stage', 'stage_id'],
    ['Account', 'account_id'],
    ['Contact email', 'primary_contact_id'],
    ['Owner', 'owner_id'],
    ['Expected close date', 'expected_close_date'],
    ['Lost reason', 'lost_reason'],
    ['Deal ID', 'external_id'],
    ['Created date', 'created_at'],
    ['Closed date', 'closed_at'],
  ],
};

export function templateHeadings(
  objectType: ImportableObjectType,
  targets: readonly SuggestableTarget[],
): string[] {
  const offered = new Set(targets.map((target) => target.key));
  return TEMPLATE_HEADINGS[objectType]
    .filter(([, key]) => offered.has(key))
    .map(([heading]) => heading);
}
