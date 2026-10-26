import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * The remembered result of a bulk action that carried an Idempotency-Key
 * (migration 0023, ADR-0056).
 *
 * A retry with the same key and the same request replays `result`; the same key with a different
 * request is refused. Rows are the caller's own (a restrictive policy) and are swept after a day.
 */
export const bulkOperations = pgTable(
  'bulk_operations',
  {
    ...baseColumns,
    idempotencyKey: text('idempotency_key').notNull(),
    objectType: text('object_type').notNull(),
    action: text('action').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex('bulk_operations_key').on(table.tenantId, table.createdBy, table.idempotencyKey),
    index('bulk_operations_created_idx').on(table.tenantId, table.createdBy, table.createdAt),
  ],
);

export type BulkOperationRow = typeof bulkOperations.$inferSelect;
