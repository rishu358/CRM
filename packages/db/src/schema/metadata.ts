import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { FieldValidation, PicklistOption } from '@crm/core';
import { baseColumns } from './columns.js';

/**
 * Field metadata (ADR-0004).
 *
 * Every tenant's objects are described here, including the system fields we
 * ship. Keeping system fields in the same table as custom ones means forms,
 * list views, filters, import and export have exactly one source to read — the
 * moment there are two, one of them gets forgotten.
 */
export const fieldDefinitions = pgTable(
  'field_definitions',
  {
    ...baseColumns,
    objectType: text('object_type').notNull(),
    /** Stable identifier used as the jsonb key and in the API. Immutable. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** One of @crm/core FIELD_TYPES. */
    type: text('type').notNull(),
    required: boolean('required').notNull().default(false),
    /** Enforced by a partial unique index created on demand, not by this flag alone. */
    isUnique: boolean('is_unique').notNull().default(false),
    /** Picklist options: [{ value, label, isActive }]. */
    options: jsonb('options').$type<readonly PicklistOption[]>(),
    /** min, max, lengths, pattern, allowed currencies. */
    validation: jsonb('validation').$type<FieldValidation>(),
    defaultValue: jsonb('default_value'),
    position: integer('position').notNull().default(0),
    /** System fields may be relabelled and reordered, never deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    /** Deactivating hides the field and blocks writes but keeps the data. */
    isActive: boolean('is_active').notNull().default(true),
    /** The heading a record page groups this field under; null is the default group (migration 0019). */
    section: text('section'),
    /** One line saying what the field is for, shown beside it. */
    helpText: text('help_text'),
    /** Optimistic locking: a second administrator's stale save is refused, not merged (migration 0019). */
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('field_definitions_tenant_object_key').on(
      table.tenantId,
      table.objectType,
      table.key,
    ),
    index('field_definitions_tenant_object_idx').on(
      table.tenantId,
      table.objectType,
      table.position,
    ),
  ],
);

/** Saved list views: filters, columns and sort, shared at the chosen visibility. */
export const savedViews = pgTable(
  'saved_views',
  {
    ...baseColumns,
    objectType: text('object_type').notNull(),
    name: text('name').notNull(),
    filters: jsonb('filters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    columns: jsonb('columns')
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sort: jsonb('sort')
      .$type<readonly Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** private | team | tenant */
    visibility: text('visibility').notNull().default('private'),
    /** Optimistic locking: a second editor's stale save is refused, not merged (migration 0023). */
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('saved_views_tenant_object_idx').on(table.tenantId, table.objectType),
    uniqueIndex('saved_views_tenant_object_name_owner_key').on(
      table.tenantId,
      table.objectType,
      table.name,
      table.createdBy,
    ),
  ],
);

export type FieldDefinitionRow = typeof fieldDefinitions.$inferSelect;
export type NewFieldDefinitionRow = typeof fieldDefinitions.$inferInsert;
export type SavedView = typeof savedViews.$inferSelect;
