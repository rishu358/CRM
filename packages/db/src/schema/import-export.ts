import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Import and export jobs (MVP_SPEC §M8, ADR-0029).
 *
 * These rows say that a file exists and what has happened to it. They never
 * hold the file: that lives in object storage under a random key and moves on
 * presigned URLs (CLAUDE.md §5.12).
 */

export type ImportStatus =
  | 'awaiting_upload'
  | 'analyzing'
  | 'awaiting_mapping'
  | 'staging'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rejected';

export type ImportDuplicateMode = 'skip' | 'update' | 'create';

/** One mapped column: which file column feeds which target field. */
export interface ImportMappingEntry {
  readonly column: number;
  readonly field: string;
}

export const importJobs = pgTable(
  'import_jobs',
  {
    ...baseColumns,
    objectType: text('object_type').$type<'account' | 'contact' | 'lead' | 'deal'>().notNull(),
    status: text('status').$type<ImportStatus>().notNull().default('awaiting_upload'),
    fileName: text('file_name').notNull(),
    claimedFormat: text('claimed_format').$type<'csv' | 'xlsx'>().notNull(),
    detectedFormat: text('detected_format').$type<'csv' | 'xlsx'>(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    idempotencyKey: text('idempotency_key'),
    columns: jsonb('columns').$type<string[]>(),
    preview: jsonb('preview').$type<string[][]>(),
    mapping: jsonb('mapping').$type<ImportMappingEntry[]>(),
    duplicateMode: text('duplicate_mode').$type<ImportDuplicateMode>(),
    matchField: text('match_field'),
    totalRows: integer('total_rows'),
    processedRows: integer('processed_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errorFileKey: text('error_file_key'),
    failureReason: text('failure_reason'),
    /** A check: the same rows through the same logic, every chunk rolled back (ADR-0068). */
    dryRun: boolean('dry_run').notNull().default(false),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    index('import_jobs_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('import_jobs_tenant_creator_idx').on(table.tenantId, table.createdBy, table.createdAt),
    uniqueIndex('import_jobs_idempotency_key')
      .on(table.tenantId, table.createdBy, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const importRows = pgTable(
  'import_rows',
  {
    ...baseColumns,
    jobId: uuid('job_id').notNull(),
    /** The data row's ordinal, 1..n; what the job's checkpoint counts. */
    rowNumber: integer('row_number').notNull(),
    /** The row number in the user's own spreadsheet (header is 1). */
    sourceRow: integer('source_row').notNull(),
    cells: jsonb('cells').$type<string[]>().notNull(),
  },
  (table) => [index('import_rows_tenant_job_idx').on(table.tenantId, table.jobId, table.rowNumber)],
);

export const importErrors = pgTable(
  'import_errors',
  {
    ...baseColumns,
    jobId: uuid('job_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    field: text('field'),
    message: text('message').notNull(),
  },
  (table) => [
    index('import_errors_tenant_job_idx').on(table.tenantId, table.jobId, table.rowNumber),
  ],
);

export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExportQuery {
  readonly filter?: readonly string[];
  readonly sort?: string;
  readonly q?: string;
}

export const exportJobs = pgTable(
  'export_jobs',
  {
    ...baseColumns,
    objectType: text('object_type').$type<'account' | 'contact' | 'lead' | 'deal'>().notNull(),
    status: text('status').$type<ExportStatus>().notNull().default('queued'),
    format: text('format').$type<'csv' | 'xlsx'>().notNull(),
    query: jsonb('query')
      .$type<ExportQuery>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    storageKey: text('storage_key').notNull(),
    rowCount: integer('row_count'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    failureReason: text('failure_reason'),
    expiresAt: timestamptz('expires_at').notNull(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('export_jobs_tenant_creator_idx').on(table.tenantId, table.createdBy, table.createdAt),
    uniqueIndex('export_jobs_idempotency_key')
      .on(table.tenantId, table.createdBy, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
export type ImportRow = typeof importRows.$inferSelect;
export type ImportError = typeof importErrors.$inferSelect;
export type ExportJob = typeof exportJobs.$inferSelect;
export type NewExportJob = typeof exportJobs.$inferInsert;
