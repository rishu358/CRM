import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DataExportKind, ErasableObjectType, ErasureStatus } from '@crm/core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Data rights and the archives that serve them (MVP_SPEC M11).
 *
 * Three features share this file because they share a shape: each is a request
 * recorded in the database, authorized once at the request and **again** when
 * the worker runs it, and each produces either a file in object storage or a
 * change the worker makes on the requester's behalf.
 */

export type DataExportStatus = 'queued' | 'running' | 'completed' | 'failed';

/** What was asked for. Validated by Zod at the API boundary before it is stored. */
export interface DataExportParams {
  /** `audit_log`: the viewer's filters, exactly as the list endpoint took them. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly actorId?: string | undefined;
  readonly objectType?: string | undefined;
  readonly action?: string | undefined;
  readonly recordId?: string | undefined;
  /** `data_subject`: whose file this is. */
  readonly subjectObjectType?: ErasableObjectType | undefined;
  readonly subjectRecordId?: string | undefined;
}

/**
 * The audit-log, whole-tenant and one-person archives.
 *
 * Deliberately **not** `export_jobs`. A list export is "this object type, these
 * filters, under your record scope"; these are "the audit log", "everything this
 * workspace holds" and "one person's file". Different handler, different
 * capability, different shape — and folding them together would mean every
 * list-export path had to start asking which kind it was holding.
 */
export const dataExportJobs = pgTable(
  'data_export_jobs',
  {
    ...baseColumns,
    kind: text('kind').$type<DataExportKind>().notNull(),
    status: text('status').$type<DataExportStatus>().notNull().default('queued'),
    format: text('format').$type<'csv' | 'json'>().notNull(),
    params: jsonb('params')
      .$type<DataExportParams>()
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
    index('data_export_jobs_tenant_creator_idx').on(
      table.tenantId,
      table.createdBy,
      table.createdAt,
    ),
    uniqueIndex('data_export_jobs_idempotency_key')
      .on(table.tenantId, table.createdBy, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/**
 * A DPDP/GDPR erasure (MVP_SPEC M11, ADR-0032).
 *
 * Two jobs at once. It is the compliance record — who asked, who approved,
 * when it completed, what it reached — and it is the **authorization token for
 * the audit redaction**: the policy on `audit_logs` permits `crm_erasure` to
 * rewrite a diff only while a row here says that subject's erasure is
 * `processing`. Read ADR-0032 before changing anything about its status
 * transitions; the window is the security control.
 *
 * Never deleted, by either role: an erasure request is itself something a
 * regulator may ask to see.
 */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    ...baseColumns,
    subjectObjectType: text('subject_object_type').$type<ErasableObjectType>().notNull(),
    subjectRecordId: uuid('subject_record_id').notNull(),
    status: text('status').$type<ErasureStatus>().notNull().default('pending'),
    /** Why, in the requester's words. Length-capped; never the subject's data. */
    reason: text('reason'),
    recordsErased: integer('records_erased').notNull().default(0),
    auditRowsRedacted: integer('audit_rows_redacted').notNull().default(0),
    failureReason: text('failure_reason'),
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    // One in-flight request per subject — see the migration for why that is a
    // correctness rule and not just tidiness.
    uniqueIndex('erasure_requests_one_in_flight')
      .on(table.tenantId, table.subjectObjectType, table.subjectRecordId)
      .where(sql`${table.status} in ('pending', 'processing')`),
    index('erasure_requests_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export type DataExportJob = typeof dataExportJobs.$inferSelect;
export type NewDataExportJob = typeof dataExportJobs.$inferInsert;
export type ErasureRequest = typeof erasureRequests.$inferSelect;
export type NewErasureRequest = typeof erasureRequests.$inferInsert;
