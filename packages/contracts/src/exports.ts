import { z } from 'zod';
import { listQuerySchema } from './pagination.js';

/**
 * Export contracts (MVP_SPEC §M8, ADR-0029).
 *
 * An export is **a list query that runs to completion in the background**, so
 * its filter, sort and search are exactly the list endpoint's, validated by the
 * same rules against the same field metadata. There is no export-only filter
 * dialect: the number of rows in the file is the number of rows on the screen
 * the user exported from.
 *
 * What is absent: no `fields` and no column list. Which columns an export has
 * is decided by field metadata and the caller's field permissions, never by the
 * request — a client that could ask for a column by name could ask for one it
 * may not read.
 */

export const exportObjectTypeSchema = z.enum(['account', 'contact', 'lead', 'deal']);
export type ExportObjectType = z.infer<typeof exportObjectTypeSchema>;

export const exportFormatSchema = z.enum(['csv', 'xlsx']);

export const exportStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);

export const exportCreateSchema = z
  .object({
    objectType: exportObjectTypeSchema,
    format: exportFormatSchema.default('csv'),
    filter: listQuerySchema.shape.filter,
    sort: listQuerySchema.shape.sort,
    q: listQuerySchema.shape.q,
  })
  .strict();

export type ExportCreateInput = z.infer<typeof exportCreateSchema>;

export const exportJobSchema = z.object({
  id: z.uuid(),
  objectType: exportObjectTypeSchema,
  status: exportStatusSchema,
  format: exportFormatSchema,
  rowCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  /** After this the link is refused and the file is swept. */
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type ExportJob = z.infer<typeof exportJobSchema>;

export const exportParamsSchema = z.object({ id: z.uuid() }).strict();
