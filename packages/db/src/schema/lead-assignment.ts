import { sql } from 'drizzle-orm';
import {
  boolean,
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
 * Lead assignment rules (migration 0028, ADR-0065 10): who gets a new lead.
 *
 * `conditions` and `action` are validated by `@crm/core` (`checkRuleShape`) before they are written
 * and typed there; here they are plain JSON, so the database package need not know the rule language.
 */
export const leadAssignmentRules = pgTable(
  'lead_assignment_rules',
  {
    ...baseColumns,
    name: text('name').notNull(),
    position: integer('position').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    appliesTo: text('applies_to')
      .array()
      .notNull()
      .default(sql`'{web_form}'::text[]`),
    conditions: jsonb('conditions')
      .$type<readonly Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    action: jsonb('action').$type<Record<string, unknown>>().notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('lead_assignment_rules_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('lead_assignment_rules_order_idx').on(table.tenantId, table.position, table.id),
  ],
);

export const leadAssignmentPointers = pgTable(
  'lead_assignment_pointers',
  {
    tenantId: uuid('tenant_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    lastUserId: uuid('last_user_id'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.ruleId] })],
);

export const leadAssignmentSettings = pgTable('lead_assignment_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  defaultOwnerId: uuid('default_owner_id'),
  version: integer('version').notNull().default(1),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .default(sql`now()`),
  updatedBy: uuid('updated_by'),
});
