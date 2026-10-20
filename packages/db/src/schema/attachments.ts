import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Files attached to a record (MVP_SPEC §6.1, ADR-0005, ADR-0035).
 *
 * The row says a file exists, what it is called and where it is; it never
 * holds the bytes, which live in object storage under a random key and move
 * only on short-lived presigned URLs (CLAUDE.md §5.12).
 *
 * `(object_type, record_id)` is the polymorphic pair, so a custom object in P2
 * can carry files without a schema change — and, per ADR-0005, there is **no
 * foreign key to the target**. Integrity is the service's job on write and the
 * worker's on delete.
 */

export type AttachmentStatus = 'awaiting_upload' | 'scanning' | 'ready' | 'rejected';

export const attachments = pgTable(
  'attachments',
  {
    ...baseColumns,
    objectType: text('object_type')
      .$type<'account' | 'contact' | 'lead' | 'deal' | 'activity'>()
      .notNull(),
    recordId: uuid('record_id').notNull(),
    /** Random, 256 bits, never derived from anything the user typed. */
    fileKey: text('file_key').notNull(),
    /** Display only. Validated on write and sanitised again at download. */
    fileName: text('file_name').notNull(),
    /** Chosen by the server from the allow-listed extension, never by the client. */
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: text('status').$type<AttachmentStatus>().notNull().default('awaiting_upload'),
    /** What the worker found in the bytes. Null until it has looked. */
    detectedFormat: text('detected_format'),
    /** A sentence for the user when the file was refused. Never a stack trace. */
    failureReason: text('failure_reason'),
    /**
     * Soft delete. The bytes outlive it by the retention window so that an
     * undelete can bring the file back, then the worker purges both
     * (ADR-0035).
     */
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    // "The files on this record", in keyset order (ADR-0012), live rows only.
    index('attachments_target_idx')
      .on(table.tenantId, table.objectType, table.recordId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    index('attachments_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    // Keys are random, so a collision means a bug rather than an attack; this
    // turns that bug into a failed insert instead of two rows sharing a file.
    uniqueIndex('attachments_file_key').on(table.tenantId, table.fileKey),
  ],
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
