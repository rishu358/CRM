import {
  canReadField,
  canWriteField,
  FieldNotWritableError,
  type Actor,
  type FieldDefinition,
} from '@crm/core';
import type { Deal as DealRow } from '@crm/db';

/**
 * Field-level permissions, applied at the boundary (CLAUDE.md §5.4).
 *
 * This is the **last** thing between the database and the response body, and
 * every read path has to come through it — record page, list, board, search
 * results, export, audit diffs. A path that skips it is the path that leaks.
 *
 * `field_definitions` keys are snake_case, matching the column and jsonb key.
 * The API speaks camelCase. The mapping lives here so a permission check is
 * never accidentally made against the wrong name — which would silently pass.
 */
const STANDARD_FIELD_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  accountId: 'account_id',
  primaryContactId: 'primary_contact_id',
  pipelineId: 'pipeline_id',
  stageId: 'stage_id',
  /**
   * One API field over two columns, as `annualRevenue` is on accounts.
   *
   * `amount_minor` and `currency` are stored apart because that is what the
   * database can index and constrain, but they are one value: a permission
   * that hid the amount and left the currency would still tell a reader which
   * currency a hidden deal is in.
   */
  amount: 'amount',
  probability: 'probability',
  expectedCloseDate: 'expected_close_date',
  closedAt: 'closed_at',
  lostReason: 'lost_reason',
  ownerId: 'owner_id',
};

/** The people on a deal are one permissioned field, keyed `contacts`. */
const CONTACTS_FIELD_KEY = 'contacts';

/** Always visible: identity and concurrency metadata, not business data. */
const ALWAYS_VISIBLE = ['id', 'version', 'createdAt', 'updatedAt'] as const;

export interface SerializedDeal {
  readonly [key: string]: unknown;
}

export interface DealPerson {
  readonly contactId: string;
  readonly role: string | null;
}

/**
 * Money on the way out (ADR-0011): the amount is a **string** of minor units,
 * because `amount_minor` is a bigint and a JSON number would round it.
 */
function serializeAmount(row: DealRow): { amountMinor: string; currency: string } | null {
  if (row.amountMinor === null || row.currency === null) return null;
  return { amountMinor: row.amountMinor.toString(), currency: row.currency };
}

function standardValue(row: DealRow, apiKey: string): unknown {
  switch (apiKey) {
    case 'amount':
      return serializeAmount(row);
    case 'closedAt':
      return row.closedAt === null ? null : row.closedAt.toISOString();
    default:
      return (row as unknown as Record<string, unknown>)[apiKey] ?? null;
  }
}

/**
 * Build the response body for one deal.
 *
 * A field the actor may not read is **omitted**, not nulled: a null would
 * still confirm the field exists and that this record has a value for it.
 */
export function serializeDeal(
  actor: Actor,
  row: DealRow,
  fields: readonly FieldDefinition[],
  people: readonly DealPerson[] = [],
): SerializedDeal {
  const result: Record<string, unknown> = {};

  for (const key of ALWAYS_VISIBLE) {
    result[key] = key === 'createdAt' || key === 'updatedAt' ? row[key].toISOString() : row[key];
  }

  for (const [apiKey, fieldKey] of Object.entries(STANDARD_FIELD_KEYS)) {
    if (!canReadField(actor, 'deal', fieldKey)) continue;
    result[apiKey] = standardValue(row, apiKey);
  }

  if (canReadField(actor, 'deal', CONTACTS_FIELD_KEY)) {
    result['contacts'] = people.map((person) => ({
      contactId: person.contactId,
      role: person.role,
    }));
  }

  const customFields: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isSystem || !field.isActive) continue;
    if (!canReadField(actor, 'deal', field.key)) continue;
    customFields[field.key] = row.customFields[field.key] ?? null;
  }
  result['customFields'] = customFields;

  return result;
}

export function serializeDeals(
  actor: Actor,
  rows: readonly DealRow[],
  fields: readonly FieldDefinition[],
  peopleByDeal: ReadonlyMap<string, readonly DealPerson[]>,
): SerializedDeal[] {
  return rows.map((row) => serializeDeal(actor, row, fields, peopleByDeal.get(row.id) ?? []));
}

/**
 * Reject a write that touches a field the actor may not write.
 *
 * Rejected, never silently dropped: dropping tells the user their edit saved
 * when it did not, and hides a genuine permission misconfiguration from
 * whoever set it up. Hidden and read-only fields are reported identically so
 * the error cannot be used to discover which fields exist but are concealed.
 */
export function assertWritableDealFields(
  actor: Actor,
  payload: Record<string, unknown>,
  fields: readonly FieldDefinition[],
): void {
  const rejected: string[] = [];

  for (const apiKey of Object.keys(payload)) {
    if (apiKey === 'customFields' || apiKey === 'version') continue;

    if (apiKey === 'contacts') {
      if (!canWriteField(actor, 'deal', CONTACTS_FIELD_KEY)) rejected.push(apiKey);
      continue;
    }

    const fieldKey = STANDARD_FIELD_KEYS[apiKey];
    if (fieldKey === undefined) continue;
    if (!canWriteField(actor, 'deal', fieldKey)) rejected.push(apiKey);
  }

  const custom = payload['customFields'];
  if (custom !== undefined && custom !== null && typeof custom === 'object') {
    for (const key of Object.keys(custom)) {
      const definition = fields.find((field) => field.key === key);
      if (definition === undefined || !definition.isActive) {
        // Unknown or deactivated: reported the same way, so probing for the
        // existence of a concealed field learns nothing.
        rejected.push(key);
        continue;
      }
      if (!canWriteField(actor, 'deal', key)) rejected.push(key);
    }
  }

  if (rejected.length > 0) throw new FieldNotWritableError(rejected);
}

export { STANDARD_FIELD_KEYS };
