import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Website lead forms (migration 0027, ADR-0065).
 *
 * Read the migration's header before changing any of this: the grants on `lead_form_keys` are the
 * design of the public door, not an implementation detail.
 */

/** A SHA-256 digest. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** One field a form asks for, in display order. Keys are lead field keys. */
export interface LeadFormField {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly helpText?: string | undefined;
}

export const leadForms = pgTable(
  'lead_forms',
  {
    ...baseColumns,
    name: text('name').notNull(),
    status: text('status').$type<'enabled' | 'disabled'>().notNull().default('enabled'),
    fields: jsonb('fields')
      .$type<readonly LeadFormField[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    consentText: text('consent_text').notNull(),
    consentVersion: integer('consent_version').notNull().default(1),
    privacyUrl: text('privacy_url'),
    successMessage: text('success_message').notNull(),
    successRedirectUrl: text('success_redirect_url'),
    allowedOrigins: text('allowed_origins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    phoneCountryCode: text('phone_country_code'),
    version: integer('version').notNull().default(1),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    uniqueIndex('lead_forms_tenant_name_key')
      .on(table.tenantId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} is null`),
    index('lead_forms_tenant_created_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export type LeadFormRow = typeof leadForms.$inferSelect;

export const leadFormKeys = pgTable(
  'lead_form_keys',
  {
    ...baseColumns,
    formId: uuid('form_id').notNull(),
    keyHash: bytea('key_hash').notNull(),
    hint: text('hint').notNull(),
    retiresAt: timestamptz('retires_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    uniqueIndex('lead_form_keys_hash_key').on(table.keyHash),
    index('lead_form_keys_form_idx').on(table.tenantId, table.formId),
  ],
);

export type LeadFormKeyRow = typeof leadFormKeys.$inferSelect;

export const leadFormConsentTexts = pgTable(
  'lead_form_consent_texts',
  {
    ...baseColumns,
    formId: uuid('form_id').notNull(),
    version: integer('version').notNull(),
    text: text('text').notNull(),
  },
  (table) => [
    uniqueIndex('lead_form_consent_texts_version_key').on(
      table.tenantId,
      table.formId,
      table.version,
    ),
  ],
);

export const leadFormSubmissions = pgTable(
  'lead_form_submissions',
  {
    ...baseColumns,
    formId: uuid('form_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    consentVersion: integer('consent_version').notNull(),
    consentAt: timestamptz('consent_at').notNull(),
    source: text('source').notNull().default('web_form'),
    idempotencyHash: bytea('idempotency_hash'),
    duplicateOfType: text('duplicate_of_type').$type<'lead' | 'contact'>(),
    duplicateOfId: uuid('duplicate_of_id'),
  },
  (table) => [
    uniqueIndex('lead_form_submissions_idempotency_key')
      .on(table.tenantId, table.formId, table.idempotencyHash)
      .where(sql`${table.idempotencyHash} is not null`),
    index('lead_form_submissions_form_idx').on(table.tenantId, table.formId, table.createdAt),
    index('lead_form_submissions_lead_idx').on(table.tenantId, table.leadId),
  ],
);

export const leadFormDailyCounts = pgTable(
  'lead_form_daily_counts',
  {
    tenantId: uuid('tenant_id').notNull(),
    counterKey: text('counter_key').notNull(),
    day: date('day').notNull(),
    count: integer('count').notNull().default(0),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.counterKey, table.day] })],
);

/** The workspace-wide pause: one row per workspace that has ever used it (migration 0027). */
export const leadFormSettings = pgTable('lead_form_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  paused: boolean('paused').notNull().default(false),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
  updatedBy: uuid('updated_by'),
});
