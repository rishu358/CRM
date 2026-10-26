import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { SearchableObjectType, SearchWeight } from '@crm/core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * The global search index (MVP_SPEC §M7, ADR-0028).
 *
 * **One row per (record, field)**, not per record. A caller's field
 * permissions decide what they may match on, and a single vector per record
 * cannot tell you which field matched — so a hidden field would stay
 * searchable even though the column itself is stripped from every response.
 * Splitting by field turns "do not search what you may not read" into a
 * predicate the database applies while selecting rows, and makes the snippet
 * a value of a field the caller may read by construction.
 *
 * A projection, never a source of truth. Rows are written by the outbox relay
 * (ADR-0006) and can be rebuilt from the records at any time with
 * `pnpm db:reindex`.
 *
 * `search_vector` is a **generated** column and is deliberately absent from
 * this type: nothing in TypeScript may supply it, because a vector that
 * disagreed with `value` would make a record findable by words it does not
 * contain. Postgres derives it from `value` and `weight` (migration 0011).
 */
export const searchDocuments = pgTable(
  'search_documents',
  {
    ...baseColumns,
    objectType: text('object_type').$type<SearchableObjectType>().notNull(),
    recordId: uuid('record_id').notNull(),
    /** A `field_definitions` key, which is also the source column's name. */
    fieldKey: text('field_key').notNull(),
    /**
     * A copy of the record's ownership column — `assigned_to` for an activity
     * (ADR-0026), `owner_id` for everything else — so record scope is a
     * predicate here rather than a join back to five tables.
     */
    ownerId: uuid('owner_id'),
    /** The indexed text, kept verbatim because it is also the snippet. */
    value: text('value').notNull(),
    weight: text('weight').$type<SearchWeight>().notNull(),
    /** The record's `updated_at`, for a stable tie-break between equal scores. */
    recordUpdatedAt: timestamptz('record_updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('search_documents_record_field_key').on(
      table.tenantId,
      table.objectType,
      table.recordId,
      table.fieldKey,
    ),
    // Migration 0021 (ADR-0041): both GIN indexes lead with `(tenant_id, owner_id)`, so an
    // own-scope search reads only its own rows, and `search_documents_recent_idx (tenant_id,
    // record_updated_at desc, id desc)` lets a broad term stop after `SEARCH_CANDIDATE_CAP`
    // matches instead of ranking every one.
    // The two GIN indexes the latency budget depends on are declared in the
    // migration and nowhere else: Drizzle cannot express
    // `gin (tenant_id, search_vector)` or `gin_trgm_ops`, and a half-expressed
    // index here would be worse than an honest pointer to where they live.
  ],
);

export type SearchDocumentRow = typeof searchDocuments.$inferSelect;
export type NewSearchDocumentRow = typeof searchDocuments.$inferInsert;
