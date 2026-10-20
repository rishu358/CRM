import { DATA_EXPORT_KINDS, ERASABLE_OBJECT_TYPES } from '@crm/core';
import { z } from 'zod';
import { auditListQuerySchema } from './audit.js';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination.js';

/**
 * Data-rights contracts (MVP_SPEC M11): DPDP and GDPR.
 *
 * Three archives and one erasure, each authorized by its own capability so that
 * granting the mildest is not granting the sharpest (see `SYSTEM_ROLES`):
 *
 *   - `audit_log`    the log, under the viewer's filters — `audit_log:export`
 *   - `tenant`       everything this workspace holds — `tenant_data:export`,
 *                    the Owner alone
 *   - `data_subject` one person's file — `data_subject:export`
 *
 * and erasure, `data_subject:delete`, the Owner alone.
 */

export const dataExportKindSchema = z.enum(DATA_EXPORT_KINDS);
export type DataExportKindInput = z.infer<typeof dataExportKindSchema>;

export const erasableObjectTypeSchema = z.enum(ERASABLE_OBJECT_TYPES);

/**
 * JSON or CSV.
 *
 * JSON is the default for the whole-tenant and one-person archives because they
 * are a graph — a contact with its activities, notes and deals — and flattening
 * a graph into one CSV loses the links. CSV stays available because a
 * spreadsheet is what most people actually open, and every cell of it goes
 * through the same formula-injection escaping every other export does
 * (CLAUDE.md §5.11).
 */
export const dataExportFormatSchema = z.enum(['json', 'csv']);

export const dataExportCreateSchema = z
  .object({
    kind: dataExportKindSchema,
    format: dataExportFormatSchema.default('json'),
    /**
     * For `audit_log`: the same filters the viewer takes, so the file contains
     * what the screen showed. For `data_subject`: whose file it is. Ignored for
     * `tenant`, which has nothing to narrow.
     */
    filters: auditListQuerySchema
      .pick({ from: true, to: true, actorId: true, objectType: true, action: true, recordId: true })
      .optional(),
    subject: z
      .object({
        objectType: erasableObjectTypeSchema,
        recordId: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    // A whole-workspace or one-person archive is a graph — a contact with its
    // activities, its timeline and its tags — and a single CSV cannot hold one
    // without flattening away the links that make it answerable. The right CSV
    // shape is a zip of one file per table, which this release deliberately
    // does not build; JSON says the same thing completely today.
    if (input.format === 'csv' && input.kind !== 'audit_log') {
      ctx.addIssue({
        code: 'custom',
        path: ['format'],
        message: 'Only the audit-log archive is available as CSV; use JSON for this kind',
      });
    }
    if (input.kind === 'data_subject' && input.subject === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'A data-subject archive needs a subject',
      });
    }
  });

export type DataExportCreateInput = z.infer<typeof dataExportCreateSchema>;

export const dataExportJobSchema = z.object({
  id: z.uuid(),
  kind: dataExportKindSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  format: dataExportFormatSchema,
  rowCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type DataExportJobContract = z.infer<typeof dataExportJobSchema>;

export const dataExportParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * Ask for a person to be erased.
 *
 * The request names the subject record and why. It does **not** name what to
 * erase: which columns are personal is a judgement about the schema that lives
 * in `PII_COLUMNS` in `@crm/core`, not something a caller gets to choose — a
 * client that could pick columns could pick `owner_id` and quietly detach a
 * record from its rep.
 */
export const erasureCreateSchema = z
  .object({
    subjectObjectType: erasableObjectTypeSchema,
    subjectRecordId: z.uuid(),
    /** Shown in the audit entry. Never the subject's own data. */
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export type ErasureCreateInput = z.infer<typeof erasureCreateSchema>;

export const erasureRequestSchema = z.object({
  id: z.uuid(),
  subjectObjectType: erasableObjectTypeSchema,
  subjectRecordId: z.uuid(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  reason: z.string().nullable(),
  recordsErased: z.number().int(),
  auditRowsRedacted: z.number().int(),
  failureReason: z.string().nullable(),
  requestedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type ErasureRequestContract = z.infer<typeof erasureRequestSchema>;

export const erasureListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type ErasureListQuery = z.infer<typeof erasureListQuerySchema>;

export const erasureParamsSchema = z.object({ id: z.uuid() }).strict();
