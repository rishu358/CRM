import type { BusinessObjectType } from '../objects/index.js';

/**
 * What a record merge may do (MVP_SPEC M4, ADR-0064).
 *
 * Merge folds a duplicate (the *loser*) into the record that stays (the *master*): the master keeps its
 * id, takes the values the person chose, and receives everything that pointed at the loser. The loser is
 * soft-deleted into the Recycle Bin and keeps a pointer to the master.
 *
 * Contacts and accounts only. Two deals are two opportunities, so there is nothing to fold; a lead
 * becomes a contact on conversion, which is where a duplicate is merged, and its conversion links are
 * frozen by design (ADR-0022).
 */
export const MERGEABLE_OBJECT_TYPES = ['contact', 'account'] as const;
export type MergeableObjectType = (typeof MERGEABLE_OBJECT_TYPES)[number];

export function isMergeableObjectType(value: string): value is MergeableObjectType {
  return (MERGEABLE_OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Rows one merge may move, counted across every table that pointed at the loser.
 *
 * A merge is one transaction that holds a lock on both records. Five thousand rows is a few hundred
 * milliseconds of statements; far more would hold both records, and the connection, for seconds. Above it
 * the merge **refuses and writes nothing** (`MERGE_TOO_LARGE`), and the message says how many rows the
 * records carry, so the person can remove or move some and try again. It is a cap on the work one request
 * does, not on how many things a record may have.
 */
export const MERGE_MAX_MOVED_ROWS = 5000;

/** Which record's value a field takes in the merged record. The master's, unless the person chose. */
export const MERGE_CHOICES = ['master', 'loser'] as const;
export type MergeChoice = (typeof MERGE_CHOICES)[number];

/**
 * The fields a person may choose between, by the name the API uses (the key of the update input) and the
 * `field_definitions` key that governs reading and writing it.
 *
 * Standard fields only; any active custom field may be chosen too, by its own key. Left out on purpose:
 *   - the owner: handing a record to somebody else is a reassignment, held to stricter rules (ADR-0033),
 *     so the master keeps its owner
 *   - consent and the raw address of a contact: not part of the update contract, so not fields of an edit;
 *     the master’s stay per channel, and a channel recorded only on the loser is carried over (ADR-0064)
 *
 * Two lists exist, here and in each module's serializer (`STANDARD_FIELD_KEYS`). A spec in the API
 * asserts that they agree, so a field added to one and not the other fails a test rather than becoming
 * a field a merge silently skips or an unchecked write.
 */
export const MERGE_FIELDS: Readonly<
  Record<MergeableObjectType, readonly { readonly apiKey: string; readonly fieldKey: string }[]>
> = {
  contact: [
    { apiKey: 'firstName', fieldKey: 'first_name' },
    { apiKey: 'lastName', fieldKey: 'last_name' },
    { apiKey: 'email', fieldKey: 'email' },
    { apiKey: 'phone', fieldKey: 'phone' },
    { apiKey: 'whatsapp', fieldKey: 'whatsapp' },
    { apiKey: 'title', fieldKey: 'title' },
    { apiKey: 'accountId', fieldKey: 'account_id' },
    { apiKey: 'leadSource', fieldKey: 'lead_source' },
  ],
  account: [
    { apiKey: 'name', fieldKey: 'name' },
    { apiKey: 'domain', fieldKey: 'domain' },
    { apiKey: 'industry', fieldKey: 'industry' },
    { apiKey: 'phone', fieldKey: 'phone' },
    { apiKey: 'email', fieldKey: 'email' },
    { apiKey: 'website', fieldKey: 'website' },
    { apiKey: 'gstin', fieldKey: 'gstin' },
    { apiKey: 'billingAddress', fieldKey: 'billing_address' },
    { apiKey: 'shippingAddress', fieldKey: 'shipping_address' },
    { apiKey: 'annualRevenue', fieldKey: 'annual_revenue' },
    { apiKey: 'employeeCount', fieldKey: 'employee_count' },
    { apiKey: 'parentAccountId', fieldKey: 'parent_account_id' },
  ],
};

/**
 * What a merge moves, counted per kind, for the preview and for the record of what happened.
 *
 * `null` is "you may not read that kind": a count of records somebody cannot see is itself information
 * about them, so a kind the caller has no read access to is not counted for them. The rows still move.
 */
export interface MergeCounts {
  /** Calls, meetings and tasks linked to the record (not notes). */
  readonly activities: number | null;
  readonly notes: number | null;
  /** Files, whether or not they have been scanned yet. */
  readonly files: number | null;
  /** Deals the record is the person or the company of. */
  readonly deals: number | null;
  /** Contacts of an account being merged (accounts only; 0 for a contact). */
  readonly contacts: number | null;
  /** Accounts that have the account as their parent (accounts only). */
  readonly childAccounts: number | null;
  /** Leads that were converted into the record. */
  readonly leads: number | null;
  /** Tags the master does not already carry, which it gains. */
  readonly tags: number;
}

/**
 * The object type whose `read` grant gates each count (`null`: always shown, because whoever may read
 * the record may read what hangs from it directly, as for a file, or because it is a workspace list).
 */
export const MERGE_COUNT_GATES: Readonly<
  Record<keyof MergeCounts, BusinessObjectType | 'activity' | null>
> = {
  activities: 'activity',
  notes: 'activity',
  files: null,
  deals: 'deal',
  contacts: 'contact',
  childAccounts: 'account',
  leads: 'lead',
  tags: null,
};
