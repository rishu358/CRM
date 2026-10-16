import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, citext, recordColumns } from './columns.js';

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
 * The table and its RLS policy ship now because `contacts.account_id`
 * references it. Its module arrives with the sales-core slice.
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

export type Account = typeof accounts.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type TimelineEvent = typeof timelineEvents.$inferSelect;
