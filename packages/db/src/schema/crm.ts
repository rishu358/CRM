import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, citext, recordColumns, timestamptz } from './columns.js';

/**
 * CRM business objects (MVP_SPEC §6.2).
 *
 * Standard fields are real columns; everything a tenant adds lives in
 * `custom_fields` (ADR-0004). Both are described in `field_definitions`, so no
 * caller needs to know which is which.
 */

/**
 * Accounts — the companies contacts belong to.
 *
 * `parentAccountId` is self-referencing, which makes two things the database
 * has to guarantee rather than the service: the parent belongs to the same
 * tenant (a composite foreign key on `(tenant_id, parent_account_id)`), and the
 * chain contains no cycle (a BEFORE trigger). Both live in
 * `0007_accounts_module.sql`; see ADR-0018 for why neither is left to
 * application code.
 */
export const accounts = pgTable(
  'accounts',
  {
    ...baseColumns,
    ...recordColumns,
    name: text('name').notNull(),
    domain: text('domain'),
    industry: text('industry'),
    phone: text('phone'),
    email: citext('email'),
    website: text('website'),
    /** Indian GST identification number. */
    gstin: text('gstin'),
    billingAddress: jsonb('billing_address').$type<Record<string, unknown>>(),
    shippingAddress: jsonb('shipping_address').$type<Record<string, unknown>>(),
    /** Money as minor units (ADR-0011), paired with the tenant's currency. */
    annualRevenueMinor: bigint('annual_revenue_minor', { mode: 'bigint' }),
    annualRevenueCurrency: text('annual_revenue_currency'),
    employeeCount: bigint('employee_count', { mode: 'number' }),
    parentAccountId: uuid('parent_account_id'),
  },
  (table) => [
    // Keyset pagination default order (ADR-0012), scoped to live records.
    index('accounts_tenant_created_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('accounts_tenant_owner_idx').on(table.tenantId, table.ownerId),
    index('accounts_tenant_name_idx').on(table.tenantId, table.name),
    // Sort by company name is the common list ordering; id keeps the keyset total.
    index('accounts_tenant_name_id_idx')
      .on(table.tenantId, table.name, table.id)
      .where(sql`${table.deletedAt} is null`),
    // "The children of this account", and the ancestor walk the cycle trigger runs.
    index('accounts_tenant_parent_idx')
      .on(table.tenantId, table.parentAccountId)
      .where(sql`${table.parentAccountId} is not null`),
    // Duplicate detection by domain on create and import (MVP_SPEC M4).
    index('accounts_tenant_domain_idx')
      .on(table.tenantId, table.domain)
      .where(sql`${table.deletedAt} is null`),
    index('accounts_custom_fields_idx').using('gin', table.customFields),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    ...baseColumns,
    ...recordColumns,
    firstName: text('first_name'),
    lastName: text('last_name').notNull(),
    email: citext('email'),
    /** E.164, validated in @crm/core before it reaches here. */
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    title: text('title'),
    accountId: uuid('account_id'),
    address: jsonb('address').$type<Record<string, unknown>>(),
    leadSource: text('lead_source'),
    /**
     * Consent per channel: `{ email: { status, source, at }, whatsapp: {...} }`.
     * Required by DPDP/GDPR (MVP_SPEC M11) and checked before any outbound send.
     */
    consent: jsonb('consent')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    index('contacts_tenant_created_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('contacts_tenant_owner_idx').on(table.tenantId, table.ownerId),
    index('contacts_tenant_account_idx').on(table.tenantId, table.accountId),
    // Duplicate detection on create and import (MVP_SPEC M4).
    index('contacts_tenant_email_idx')
      .on(table.tenantId, table.email)
      .where(sql`${table.deletedAt} is null`),
    index('contacts_tenant_phone_idx')
      .on(table.tenantId, table.phone)
      .where(sql`${table.deletedAt} is null`),
    index('contacts_custom_fields_idx').using('gin', table.customFields),
    // Sort by surname is the common list ordering; id keeps the keyset total.
    index('contacts_tenant_last_name_idx')
      .on(table.tenantId, table.lastName, table.id)
      .where(sql`${table.deletedAt} is null`),
  ],
);

/** Tags, attached polymorphically (ADR-0005). */
export const tags = pgTable(
  'tags',
  {
    ...baseColumns,
    name: text('name').notNull(),
    color: text('color'),
  },
  (table) => [uniqueIndex('tags_tenant_name_key').on(table.tenantId, table.name)],
);

export const recordTags = pgTable(
  'record_tags',
  {
    ...baseColumns,
    tagId: uuid('tag_id').notNull(),
    objectType: text('object_type').notNull(),
    recordId: uuid('record_id').notNull(),
  },
  (table) => [
    uniqueIndex('record_tags_unique').on(
      table.tenantId,
      table.tagId,
      table.objectType,
      table.recordId,
    ),
    index('record_tags_target_idx').on(table.tenantId, table.objectType, table.recordId),
  ],
);

/**
 * The per-record history feed (ADR-0005, ADR-0006).
 *
 * A denormalised projection built by the worker from outbox events, so the
 * record page renders its timeline with one indexed read instead of a union
 * across every table that might mention the record.
 */
export const timelineEvents = pgTable(
  'timeline_events',
  {
    ...baseColumns,
    objectType: text('object_type').notNull(),
    recordId: uuid('record_id').notNull(),
    eventType: text('event_type').notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    actorId: uuid('actor_id'),
    /** The outbox event this was projected from; makes the projection idempotent. */
    sourceEventId: uuid('source_event_id'),
  },
  (table) => [
    index('timeline_events_target_idx').on(
      table.tenantId,
      table.objectType,
      table.recordId,
      table.createdAt,
    ),
    uniqueIndex('timeline_events_source_key').on(table.tenantId, table.sourceEventId),
  ],
);

/**
 * Pipelines and their stages (MVP_SPEC M5).
 *
 * Configuration rather than records: no owner, no soft delete, no custom
 * fields. `0008_deals_module.sql` holds the integrity the schema cannot
 * express here — composite tenant keys, the stage-in-pipeline reference and
 * the triggers behind ADR-0020.
 */
export const pipelines = pgTable(
  'pipelines',
  {
    ...baseColumns,
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    uniqueIndex('pipelines_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('pipelines_tenant_position_idx').on(table.tenantId, table.position, table.id),
  ],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    ...baseColumns,
    pipelineId: uuid('pipeline_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    /** Whole percent. Fixed at 100 for won and 0 for lost. */
    probability: integer('probability').notNull().default(0),
    stageType: text('stage_type').$type<'open' | 'won' | 'lost'>().notNull().default('open'),
  },
  (table) => [
    index('pipeline_stages_pipeline_position_idx').on(
      table.tenantId,
      table.pipelineId,
      table.position,
      table.id,
    ),
  ],
);

/**
 * Deals (MVP_SPEC §6.2).
 *
 * `amountMinor` + `currency` are one value (ADR-0011). `closedAt`,
 * `probability` and `lostReason` are *derived from the stage* by the service
 * and checked by a trigger (ADR-0020); a client never sets them directly.
 */
export const deals = pgTable(
  'deals',
  {
    ...baseColumns,
    ...recordColumns,
    name: text('name').notNull(),
    accountId: uuid('account_id'),
    primaryContactId: uuid('primary_contact_id'),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: char('currency', { length: 3 }),
    probability: integer('probability').notNull().default(0),
    /** A calendar date, not an instant: "closes on the 14th" has no time zone. */
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    closedAt: timestamptz('closed_at'),
    lostReason: text('lost_reason'),
  },
  (table) => [
    index('deals_tenant_created_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('deals_tenant_stage_created_idx')
      .on(table.tenantId, table.stageId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('deals_tenant_pipeline_idx').on(table.tenantId, table.pipelineId),
    index('deals_tenant_owner_idx').on(table.tenantId, table.ownerId),
    index('deals_tenant_account_idx').on(table.tenantId, table.accountId),
    index('deals_tenant_primary_contact_idx').on(table.tenantId, table.primaryContactId),
    index('deals_tenant_name_id_idx')
      .on(table.tenantId, table.name, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('deals_tenant_close_date_idx')
      .on(table.tenantId, table.expectedCloseDate, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('deals_custom_fields_idx').using('gin', table.customFields),
  ],
);

export const dealContacts = pgTable(
  'deal_contacts',
  {
    ...baseColumns,
    dealId: uuid('deal_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    role: text('role'),
  },
  (table) => [
    uniqueIndex('deal_contacts_unique').on(table.tenantId, table.dealId, table.contactId),
    index('deal_contacts_contact_idx').on(table.tenantId, table.contactId),
  ],
);

/**
 * Manual exchange rates (MVP_SPEC M5). Major unit to major unit, held as an
 * exact decimal: `numeric` comes back as a string, so it never becomes a float.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    ...baseColumns,
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 24, scale: 12 }).notNull(),
  },
  (table) => [
    uniqueIndex('exchange_rates_pair_key').on(table.tenantId, table.fromCurrency, table.toCurrency),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type TimelineEvent = typeof timelineEvents.$inferSelect;
export type Pipeline = typeof pipelines.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
export type DealContact = typeof dealContacts.$inferSelect;
export type ExchangeRate = typeof exchangeRates.$inferSelect;
