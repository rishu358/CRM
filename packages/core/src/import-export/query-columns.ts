import type { ExportableObjectType } from './targets.js';

/**
 * The standard columns a list may be filtered or sorted on, per object, and
 * what kind of value each holds (MVP_SPEC §M8, ADR-0029).
 *
 * An export is a list query run to completion, so it must accept **exactly**
 * the keys the list endpoint accepts and treat a value of each kind the same
 * way. This table is the API's half of that promise (it validates an export
 * request before queueing it) and the worker's half (it resolves each key to a
 * column and casts the bound value by `kind`).
 *
 * It is a copy of what each module's `sql-helpers.ts` holds, and a copy can
 * drift. `exports.parity.security.spec.ts` is what stops it: it runs the same
 * filters through the real list endpoint and through an export and fails if the
 * two ever return different rows or the key sets differ. Hand-copying filter
 * SQL into the worker is a known cost of building export outside the API's
 * request path; ADR-0029 records it, and the parity test is the price of it
 * being safe.
 */
export type ColumnKind = 'text' | 'number' | 'date' | 'timestamp' | 'uuid';

export const QUERY_COLUMNS: Readonly<
  Record<ExportableObjectType, Readonly<Record<string, ColumnKind>>>
> = {
  contact: {
    first_name: 'text',
    last_name: 'text',
    email: 'text',
    phone: 'text',
    whatsapp: 'text',
    title: 'text',
    account_id: 'uuid',
    lead_source: 'text',
    owner_id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  },
  account: {
    name: 'text',
    domain: 'text',
    industry: 'text',
    phone: 'text',
    email: 'text',
    website: 'text',
    gstin: 'text',
    annual_revenue: 'number',
    employee_count: 'number',
    parent_account_id: 'uuid',
    owner_id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  },
  lead: {
    first_name: 'text',
    last_name: 'text',
    company: 'text',
    email: 'text',
    phone: 'text',
    source: 'text',
    status: 'text',
    owner_id: 'uuid',
    converted_at: 'timestamp',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  },
  deal: {
    name: 'text',
    amount: 'number',
    probability: 'number',
    expected_close_date: 'date',
    closed_at: 'timestamp',
    lost_reason: 'text',
    account_id: 'uuid',
    primary_contact_id: 'uuid',
    pipeline_id: 'uuid',
    stage_id: 'uuid',
    owner_id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  },
};

export function isStandardQueryColumn(objectType: ExportableObjectType, key: string): boolean {
  return Object.hasOwn(QUERY_COLUMNS[objectType], key);
}
