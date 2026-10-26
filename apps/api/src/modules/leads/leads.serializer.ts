import {
  canReadField,
  canWriteField,
  FieldNotWritableError,
  type Actor,
  type FieldDefinition,
} from '@crm/core';
import type { Lead as LeadRow } from '@crm/db';

/**
 * Field-level permissions, applied at the boundary (CLAUDE.md §5.4).
 *
 * The last thing between the database and the response body; every read path
 * has to come through it. A path that skips it is the path that leaks.
 *
 * `field_definitions` keys are snake_case, matching the column and jsonb key.
 * The API speaks camelCase. The mapping lives here so a permission check is
 * never accidentally made against the wrong name — which would silently pass.
 */
const STANDARD_FIELD_KEYS: Readonly<Record<string, string>> = {
  firstName: 'first_name',
  lastName: 'last_name',
  company: 'company',
  email: 'email',
  phone: 'phone',
  source: 'source',
  status: 'status',
  ownerId: 'owner_id',
};

/**
 * What conversion records. Readable under the same permission model as any
 * other field, but never writable: conversion writes them once (ADR-0022), so
 * they are absent from `STANDARD_FIELD_KEYS` and from the write contracts.
 */
const CONVERSION_FIELD_KEYS: Readonly<Record<string, string>> = {
  convertedAt: 'converted_at',
  convertedContactId: 'converted_contact_id',
  convertedAccountId: 'converted_account_id',
  convertedDealId: 'converted_deal_id',
};

/** Always visible: identity and concurrency metadata, not business data. */
const ALWAYS_VISIBLE = ['id', 'version', 'createdAt', 'updatedAt'] as const;

export interface SerializedLead {
  readonly [key: string]: unknown;
}

/**
 * Build the response body for one lead.
 *
 * A field the actor may not read is **omitted**, not nulled: a null would still
 * confirm the field exists and that this record has a value for it.
 */
export function serializeLead(
  actor: Actor,
  row: LeadRow,
  fields: readonly FieldDefinition[],
): SerializedLead {
  const result: Record<string, unknown> = {};

  for (const key of ALWAYS_VISIBLE) {
    result[key] = key === 'createdAt' || key === 'updatedAt' ? row[key].toISOString() : row[key];
  }

  const record = row as unknown as Record<string, unknown>;

  for (const [apiKey, fieldKey] of Object.entries(STANDARD_FIELD_KEYS)) {
    if (!canReadField(actor, 'lead', fieldKey)) continue;
    result[apiKey] = record[apiKey] ?? null;
  }

  for (const [apiKey, fieldKey] of Object.entries(CONVERSION_FIELD_KEYS)) {
    if (!canReadField(actor, 'lead', fieldKey)) continue;
    const value = record[apiKey] ?? null;
    result[apiKey] = value instanceof Date ? value.toISOString() : value;
  }

  const customFields: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isSystem || !field.isActive) continue;
    if (!canReadField(actor, 'lead', field.key)) continue;
    customFields[field.key] = row.customFields[field.key] ?? null;
  }
  result['customFields'] = customFields;

  return result;
}

export function serializeLeads(
  actor: Actor,
  rows: readonly LeadRow[],
  fields: readonly FieldDefinition[],
): SerializedLead[] {
  return rows.map((row) => serializeLead(actor, row, fields));
}

/**
 * Reject a write that touches a field the actor may not write.
 *
 * Rejected, never silently dropped: dropping tells the user their edit saved
 * when it did not, and hides a genuine permission misconfiguration from
 * whoever set it up. Hidden and read-only fields are reported identically so
 * the error cannot be used to discover which fields exist but are concealed.
 */
export function assertWritableLeadFields(
  actor: Actor,
  payload: Record<string, unknown>,
  fields: readonly FieldDefinition[],
): void {
  const rejected: string[] = [];

  for (const apiKey of Object.keys(payload)) {
    if (apiKey === 'customFields' || apiKey === 'version') continue;
    const fieldKey = STANDARD_FIELD_KEYS[apiKey];
    if (fieldKey === undefined) continue;
    if (!canWriteField(actor, 'lead', fieldKey)) rejected.push(apiKey);
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
      if (!canWriteField(actor, 'lead', key)) rejected.push(key);
    }
  }

  if (rejected.length > 0) throw new FieldNotWritableError(rejected);
}

export { STANDARD_FIELD_KEYS };
