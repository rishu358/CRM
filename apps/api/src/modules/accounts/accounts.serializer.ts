import {
  canReadField,
  canWriteField,
  FieldNotWritableError,
  type Actor,
  type FieldDefinition,
} from '@crm/core';
import type { Account as AccountRow } from '@crm/db';

/**
 * Field-level permissions, applied at the boundary (CLAUDE.md §5.4).
 *
 * This is the **last** thing between the database and the response body, and
 * every read path has to come through it — record page, list, search results,
 * export, audit diffs. A path that skips it is the path that leaks.
 *
 * `field_definitions` keys are snake_case, matching the column and jsonb key.
 * The API speaks camelCase. The mapping lives here so a permission check is
 * never accidentally made against the wrong name — which would silently pass.
 */
const STANDARD_FIELD_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  domain: 'domain',
  industry: 'industry',
  phone: 'phone',
  email: 'email',
  website: 'website',
  gstin: 'gstin',
  billingAddress: 'billing_address',
  shippingAddress: 'shipping_address',
  /**
   * One API field over two columns.
   *
   * `annual_revenue_minor` and `annual_revenue_currency` are stored apart
   * because that is what the database can index and constrain, but they are
   * one value: an amount without its currency means nothing, and a permission
   * that hid one and not the other would be a permission that hid nothing.
   */
  annualRevenue: 'annual_revenue',
  employeeCount: 'employee_count',
  parentAccountId: 'parent_account_id',
  ownerId: 'owner_id',
};

/** Always visible: identity and concurrency metadata, not business data. */
const ALWAYS_VISIBLE = ['id', 'version', 'createdAt', 'updatedAt'] as const;

export interface SerializedAccount {
  readonly [key: string]: unknown;
}

/**
 * Money on the way out (ADR-0011).
 *
 * The amount is a **string** of minor units. `annual_revenue_minor` is a
 * bigint and a tenant with a billion-rupee customer has a value above 2^53;
 * turning it into a JSON number would round it, and the only people who would
 * notice are the ones with the most at stake.
 */
function serializeRevenue(row: AccountRow): { amountMinor: string; currency: string } | null {
  if (row.annualRevenueMinor === null || row.annualRevenueCurrency === null) return null;
  return {
    amountMinor: row.annualRevenueMinor.toString(),
    currency: row.annualRevenueCurrency,
  };
}

function standardValue(row: AccountRow, apiKey: string): unknown {
  if (apiKey === 'annualRevenue') return serializeRevenue(row);
  return (row as unknown as Record<string, unknown>)[apiKey] ?? null;
}

/**
 * Build the response body for one account.
 *
 * A field the actor may not read is **omitted**, not nulled: a null would
 * still confirm the field exists and that this record has a value for it.
 */
export function serializeAccount(
  actor: Actor,
  row: AccountRow,
  fields: readonly FieldDefinition[],
): SerializedAccount {
  const result: Record<string, unknown> = {};

  for (const key of ALWAYS_VISIBLE) {
    result[key] = key === 'createdAt' || key === 'updatedAt' ? row[key].toISOString() : row[key];
  }

  for (const [apiKey, fieldKey] of Object.entries(STANDARD_FIELD_KEYS)) {
    if (!canReadField(actor, 'account', fieldKey)) continue;
    result[apiKey] = standardValue(row, apiKey);
  }

  const customFields: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isSystem || !field.isActive) continue;
    if (!canReadField(actor, 'account', field.key)) continue;
    customFields[field.key] = row.customFields[field.key] ?? null;
  }
  result['customFields'] = customFields;

  return result;
}

export function serializeAccounts(
  actor: Actor,
  rows: readonly AccountRow[],
  fields: readonly FieldDefinition[],
): SerializedAccount[] {
  return rows.map((row) => serializeAccount(actor, row, fields));
}

/**
 * Reject a write that touches a field the actor may not write.
 *
 * Rejected, never silently dropped: dropping tells the user their edit saved
 * when it did not, and hides a genuine permission misconfiguration from
 * whoever set it up. Hidden and read-only fields are reported identically so
 * the error cannot be used to discover which fields exist but are concealed.
 */
export function assertWritableAccountFields(
  actor: Actor,
  payload: Record<string, unknown>,
  fields: readonly FieldDefinition[],
): void {
  const rejected: string[] = [];

  for (const apiKey of Object.keys(payload)) {
    if (apiKey === 'customFields' || apiKey === 'version') continue;
    const fieldKey = STANDARD_FIELD_KEYS[apiKey];
    if (fieldKey === undefined) continue;
    if (!canWriteField(actor, 'account', fieldKey)) rejected.push(apiKey);
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
      if (!canWriteField(actor, 'account', key)) rejected.push(key);
    }
  }

  if (rejected.length > 0) throw new FieldNotWritableError(rejected);
}

export { STANDARD_FIELD_KEYS };
