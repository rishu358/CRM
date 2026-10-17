import type { FieldDefinition } from '@crm/core';

/**
 * System field definitions (ADR-0004).
 *
 * The standard columns are registered here as field metadata so that forms,
 * list views, filters, import and export read **one** source for both system
 * and custom fields. The moment there are two sources, one of them gets
 * forgotten — usually export, which is how hidden fields leak.
 *
 * `isSystem` means the key and type are fixed. Tenants may relabel, reorder and
 * deactivate these, but not delete them.
 */

type SystemField = Omit<FieldDefinition, 'isSystem'> & { readonly isSystem: true };

function systemField(
  key: string,
  label: string,
  type: FieldDefinition['type'],
  position: number,
  overrides: Partial<FieldDefinition> = {},
): SystemField {
  return {
    key,
    label,
    type,
    required: false,
    isActive: true,
    position,
    ...overrides,
    isSystem: true,
  };
}

export const CONTACT_SYSTEM_FIELDS: readonly SystemField[] = [
  systemField('first_name', 'First name', 'text', 10),
  systemField('last_name', 'Last name', 'text', 20, { required: true }),
  systemField('email', 'Email', 'email', 30),
  systemField('phone', 'Phone', 'phone', 40),
  systemField('whatsapp', 'WhatsApp', 'phone', 50),
  systemField('title', 'Job title', 'text', 60),
  systemField('lead_source', 'Lead source', 'picklist', 70, {
    options: [
      { value: 'referral', label: 'Referral' },
      { value: 'website', label: 'Website' },
      { value: 'walk_in', label: 'Walk-in' },
      { value: 'exhibition', label: 'Exhibition' },
      { value: 'social', label: 'Social media' },
      { value: 'other', label: 'Other' },
    ],
  }),
  systemField('owner_id', 'Owner', 'user_lookup', 80),
];

export const ACCOUNT_SYSTEM_FIELDS: readonly SystemField[] = [
  systemField('name', 'Account name', 'text', 10, { required: true }),
  systemField('domain', 'Website domain', 'text', 20),
  systemField('industry', 'Industry', 'text', 30),
  systemField('phone', 'Phone', 'phone', 40),
  systemField('email', 'Email', 'email', 50),
  systemField('website', 'Website', 'url', 60),
  systemField('gstin', 'GSTIN', 'text', 70, {
    // 15 characters: 2 state code, 10 PAN, 1 entity, 1 'Z', 1 checksum.
    validation: { pattern: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}' },
  }),
  systemField('employee_count', 'Employees', 'number', 80, { validation: { min: '0' } }),
  systemField('annual_revenue', 'Annual revenue', 'currency', 85),
  systemField('owner_id', 'Owner', 'user_lookup', 90),
];
/*
 * `billing_address`, `shipping_address` and `parent_account_id` are deliberately
 * absent, and so are `address`, `account_id` and `consent` on contacts.
 *
 * There is no field type that describes them: a structured address and a
 * reference to another record would need an `address` type and `record_lookup`,
 * and `record_lookup` is P1 (MVP_SPEC §6.3). Inventing a type here would put a
 * second, informal type system next to the real one.
 *
 * The practical cost is that an admin cannot set a field permission on an
 * address, because field permissions are keyed by field key and nothing lists
 * these keys. The serializer still checks `canReadField` for them by key, so a
 * permission row written by hand is honoured — but the admin UI will not offer
 * one until the types exist.
 */

/**
 * `amount` is one field over `amount_minor` + `currency`, as `annual_revenue`
 * is on accounts: a permission that hid one half would hide nothing.
 *
 * `stage_id`, `pipeline_id`, `account_id`, `primary_contact_id`, `closed_at`
 * and `contacts` are absent for the reason given above — there is no type that
 * describes a reference — but the serializer checks `canReadField` and
 * `canWriteField` for them by key, so a permission row written for one is
 * honoured.
 */
export const DEAL_SYSTEM_FIELDS: readonly SystemField[] = [
  systemField('name', 'Deal name', 'text', 10, { required: true }),
  systemField('amount', 'Amount', 'currency', 20),
  systemField('probability', 'Probability', 'percent', 30, {
    validation: { min: '0', max: '100' },
  }),
  systemField('expected_close_date', 'Expected close date', 'date', 40),
  systemField('lost_reason', 'Lost reason', 'text', 50),
  systemField('owner_id', 'Owner', 'user_lookup', 60),
];

/**
 * Lead fields (MVP_SPEC §6.2).
 *
 * `status` is a picklist whose values are fixed by a CHECK constraint, so the
 * options here and the constraint in `0009_leads_module.sql` must agree; the
 * list is short and closed, and a tenant adding its own stage of interest
 * should add a custom field rather than widen this one.
 *
 * `converted_at`, `converted_contact_id`, `converted_account_id` and
 * `converted_deal_id` are absent, for the reason given above about references
 * and for one more: they are not editable at all. Conversion writes them once
 * (ADR-0022), so offering them as fields an admin can mark writable would be
 * offering a permission that nothing honours.
 */
export const LEAD_SYSTEM_FIELDS: readonly SystemField[] = [
  systemField('first_name', 'First name', 'text', 10),
  systemField('last_name', 'Last name', 'text', 20, { required: true }),
  systemField('company', 'Company', 'text', 30),
  systemField('email', 'Email', 'email', 40),
  systemField('phone', 'Phone', 'phone', 50),
  systemField('source', 'Source', 'picklist', 60, {
    options: [
      { value: 'referral', label: 'Referral' },
      { value: 'website', label: 'Website' },
      { value: 'walk_in', label: 'Walk-in' },
      { value: 'exhibition', label: 'Exhibition' },
      { value: 'social', label: 'Social media' },
      { value: 'other', label: 'Other' },
    ],
  }),
  systemField('status', 'Status', 'picklist', 70, {
    options: [
      { value: 'new', label: 'New' },
      { value: 'contacted', label: 'Contacted' },
      { value: 'qualified', label: 'Qualified' },
      { value: 'unqualified', label: 'Unqualified' },
      { value: 'converted', label: 'Converted' },
    ],
  }),
  systemField('owner_id', 'Owner', 'user_lookup', 80),
];

export const SYSTEM_FIELDS_BY_OBJECT: Readonly<Record<string, readonly SystemField[]>> = {
  contact: CONTACT_SYSTEM_FIELDS,
  account: ACCOUNT_SYSTEM_FIELDS,
  deal: DEAL_SYSTEM_FIELDS,
  lead: LEAD_SYSTEM_FIELDS,
};
