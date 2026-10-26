import type { BusinessObjectType } from '../objects/index.js';

/**
 * What a bulk action may touch (MVP_SPEC M4, ADR-0056).
 *
 * Bulk edit is the one place a client names a field for **many** records at once, so the set of
 * fields it may name is an allowlist, like import's (`targets.ts`). "Every field except these"
 * fails open: the next column somebody adds would become bulk-editable by default.
 *
 * Left out on purpose, and why:
 *   - identifiers a person has one of (names, email, phone, WhatsApp, GSTIN, domain): the same
 *     value on two hundred records is a mistake, not an edit, and duplicate detection would have
 *     two hundred things to say
 *   - the owner: that is `assign`, which is held to the stricter rules reassignment has
 *   - a deal's money and pipeline: an amount is per deal, and a deal changes pipeline with its
 *     stage, which the stage rules settle
 *   - lead `status = converted`: conversion is a transaction of its own (ADR-0022); the update
 *     contract already refuses it, and this list does not offer it
 *
 * Custom fields are not listed here: they are metadata, so every **active** custom field the
 * caller may write is bulk-editable, and its value is validated by the same schema a single edit
 * uses. The `property` is the name the object's own update contract gives the field.
 */

export interface BulkEditableField {
  /** The field key, as it appears in `field_definitions` and in permissions. */
  readonly key: string;
  /** The property of the object's update input that carries it. */
  readonly property: string;
}

export const BULK_EDITABLE_FIELDS: Readonly<
  Record<BusinessObjectType, readonly BulkEditableField[]>
> = {
  contact: [
    { key: 'title', property: 'title' },
    { key: 'lead_source', property: 'leadSource' },
    { key: 'account_id', property: 'accountId' },
  ],
  account: [
    { key: 'industry', property: 'industry' },
    { key: 'employee_count', property: 'employeeCount' },
    { key: 'parent_account_id', property: 'parentAccountId' },
  ],
  lead: [
    { key: 'company', property: 'company' },
    { key: 'source', property: 'source' },
    { key: 'status', property: 'status' },
  ],
  deal: [
    { key: 'stage_id', property: 'stageId' },
    { key: 'expected_close_date', property: 'expectedCloseDate' },
    { key: 'lost_reason', property: 'lostReason' },
  ],
};

export function bulkEditableField(
  objectType: BusinessObjectType,
  key: string,
): BulkEditableField | undefined {
  return BULK_EDITABLE_FIELDS[objectType].find((field) => field.key === key);
}

/**
 * Records one bulk call may handle. Two hundred is what the CRMs people move from allow, and it
 * keeps one request's transaction short: each record is a handful of statements (load, check,
 * update, audit, outbox), so the worst case is a second or two, not a held connection.
 */
export const BULK_MAX_RECORDS = 200;

/** Distinct tags one bulk call may add or remove. */
export const BULK_MAX_TAGS = 5;

/** Tags a workspace may hold. A cap, so a loop that invents a tag per record cannot fill the table. */
export const TAGS_MAX_PER_TENANT = 500;

export const TAG_NAME_MAX = 50;

/** A tag name as a person typed it: trimmed, one line, no control characters. */
export function normalizeTagName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isValidTagName(name: string): boolean {
  return name.length >= 1 && name.length <= TAG_NAME_MAX && !hasControlCharacter(name);
}

/** Why a record a bulk call named was not changed. Never says whether an out-of-scope id exists. */
export const BULK_SKIP_REASONS = [
  /** Missing, deleted, another tenant's, or outside what the caller may see: one answer for all. */
  'not_found',
  /** The caller can see it but may not do this to it. */
  'not_permitted',
  /** Somebody saved it after the call began, so this change was not applied over theirs. */
  'version_conflict',
  /** The change is not valid for this record (a rule of the record, not of the request). */
  'invalid',
  /** Already as asked: no edit, no audit entry, no event. */
  'no_change',
] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

/** Who may be shown a saved view (migration 0023). */
export const VIEW_VISIBILITIES = ['private', 'team', 'tenant'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

export const VIEW_MAX_CONDITIONS = 10;
export const VIEW_MAX_COLUMNS = 30;
export const VIEW_NAME_MAX = 80;
/** Views one person may own per object type: a ceiling, not a target. */
export const VIEW_MAX_PER_OBJECT_PER_USER = 50;
