import { IMPORT_LIMITS } from '@crm/core';
import { z } from 'zod';

/**
 * Import contracts (MVP_SPEC §M8, ADR-0029).
 *
 * Shared by the API and the import wizard. `.strict()` throughout, like every
 * other contract: an unknown key is a 422, never something to drop quietly
 * (CLAUDE.md §5.6) — which here also means a body that tries to carry an
 * `ownerId`, a `tenantId` or a `version` is refused outright rather than
 * having the key ignored.
 *
 * What is **absent** is as deliberate as what is present:
 *
 *   - no `contentType` on create. The server decides what a presigned upload
 *     is bound to from the file's claimed format; a client-supplied type is
 *     exactly the thing §5.12 says not to believe.
 *   - no file, ever. A file never passes through the API (§5.12): the response
 *     to create is a presigned URL, and the bytes go to the object store.
 */

export const importObjectTypeSchema = z.enum(['account', 'contact', 'lead']);
export type ImportObjectType = z.infer<typeof importObjectTypeSchema>;

export const importStatusSchema = z.enum([
  'awaiting_upload',
  'analyzing',
  'awaiting_mapping',
  'staging',
  'processing',
  'completed',
  'failed',
  'rejected',
]);
export type ImportStatusValue = z.infer<typeof importStatusSchema>;

export const duplicateModeSchema = z.enum(['skip', 'update', 'create']);
export type DuplicateMode = z.infer<typeof duplicateModeSchema>;

const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/;

export const importCreateSchema = z
  .object({
    objectType: importObjectTypeSchema,
    /**
     * Display only, and the source of the *claimed* format. It is never part of
     * the storage key and never used as a path.
     */
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => /\.(csv|xlsx)$/i.test(name), 'Upload a .csv or .xlsx file')
      .refine(
        (name) =>
          !/[\\/]/.test(name) && ![...name].some((character) => character.charCodeAt(0) < 0x20),
        'The file name contains invalid characters',
      ),
    /** Exact, because the presigned PUT is signed for exactly this many bytes. */
    sizeBytes: z.number().int().min(1).max(IMPORT_LIMITS.maxUploadBytes),
  })
  .strict();

export type ImportCreateInput = z.infer<typeof importCreateSchema>;

export const importMappingEntrySchema = z
  .object({
    column: z
      .number()
      .int()
      .min(0)
      .max(IMPORT_LIMITS.maxColumns - 1),
    field: z.string().regex(FIELD_KEY),
  })
  .strict();

export const importStartSchema = z
  .object({
    mapping: z.array(importMappingEntrySchema).min(1).max(IMPORT_LIMITS.maxColumns),
    duplicateMode: duplicateModeSchema,
    /** The field a row is matched to an existing record on. Not needed for `create`. */
    matchField: z.string().regex(FIELD_KEY).nullish(),
  })
  .strict();

export type ImportStartInput = z.infer<typeof importStartSchema>;

export const importTargetSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  isSystem: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const importJobSchema = z.object({
  id: z.uuid(),
  objectType: importObjectTypeSchema,
  status: importStatusSchema,
  fileName: z.string(),
  claimedFormat: z.enum(['csv', 'xlsx']),
  detectedFormat: z.enum(['csv', 'xlsx']).nullable(),
  sizeBytes: z.number().int().nullable(),
  columns: z.array(z.string()).nullable(),
  preview: z.array(z.array(z.string())).nullable(),
  mapping: z.array(importMappingEntrySchema).nullable(),
  duplicateMode: duplicateModeSchema.nullable(),
  matchField: z.string().nullable(),
  totalRows: z.number().int().nullable(),
  processedRows: z.number().int(),
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  skippedCount: z.number().int(),
  failedCount: z.number().int(),
  hasErrorFile: z.boolean(),
  /** A check: nothing was written, the counts are what would happen. */
  dryRun: z.boolean(),
  /** A sentence for the user. Never a stack trace or a driver message. */
  failureReason: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  /**
   * What this caller may map a column to, computed from live field metadata
   * and their field permissions. Present when the job is waiting for a mapping.
   */
  targets: z.array(importTargetSchema).optional(),
  matchFields: z.array(z.string()).optional(),
});

export type ImportJob = z.infer<typeof importJobSchema>;

export const presignedUploadSchema = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  /** Sent verbatim by the client; the signature is bound to them. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const importCreateResultSchema = z.object({
  job: importJobSchema,
  /** Null on a replayed create whose job has already moved past `awaiting_upload`. */
  upload: presignedUploadSchema.nullable(),
});

export const importParamsSchema = z.object({ id: z.uuid() }).strict();

export const importListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ImportListQuery = z.infer<typeof importListQuerySchema>;

/** A short-lived URL for a generated file. The only way one is ever served. */
export const downloadLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});

export type DownloadLink = z.infer<typeof downloadLinkSchema>;
