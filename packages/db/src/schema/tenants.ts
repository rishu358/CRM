import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './columns.js';

/**
 * Tenants — the isolation boundary itself.
 *
 * This table is **not** tenant-owned: it is the registry of tenants, so it
 * carries no `tenant_id` and its RLS policy restricts a session to the single
 * row naming its own tenant rather than filtering by a foreign key.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** URL-safe identifier, unique across the platform. */
    slug: text('slug').notNull(),
    /** Entitlements are looked up from this; no code may branch on it (ADR-0010). */
    plan: text('plan').notNull().default('free'),
    /** Data residency (ADR-0013). Immutable once set. */
    region: text('region').notNull().default('ap-south-1'),
    defaultCurrency: text('default_currency').notNull().default('INR'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    locale: text('locale').notNull().default('en-IN'),
    /** 1-12. India's fiscal year starts in April, so this is not always January. */
    fiscalYearStartMonth: text('fiscal_year_start_month').notNull().default('4'),
    status: text('status').notNull().default('active'),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    uniqueIndex('tenants_slug_key').on(table.slug),
    index('tenants_status_idx').on(table.status),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
