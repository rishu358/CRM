import { SOFT_DELETABLE_OBJECT_TYPES } from '@crm/core';
import { z } from 'zod';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination.js';

/**
 * Recycle Bin contracts (MVP_SPEC M4).
 *
 * "Soft delete → Recycle Bin (restore within 30 days, then hard delete by job)."
 *
 * `objectType` is **required** and the Bin is read one object type at a time.
 * A single merged list across five tables was the tempting shape and is the
 * wrong one: keyset pagination needs a total order over the rows it pages
 * through (ADR-0012), and `(deleted_at, id)` across five independently indexed
 * tables cannot be read in that order without either sorting the union in
 * memory or paging each table separately and interleaving. Both lose the
 * property the cursor exists to give. The UI shows tabs, which is also how
 * every CRM we looked at presents it.
 */

export const recyclableObjectTypeSchema = z.enum(SOFT_DELETABLE_OBJECT_TYPES);
export type RecyclableObjectType = z.infer<typeof recyclableObjectTypeSchema>;

export const recycleBinListQuerySchema = z
  .object({
    objectType: recyclableObjectTypeSchema,
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type RecycleBinListQuery = z.infer<typeof recycleBinListQuerySchema>;

export const recycleBinParamsSchema = z
  .object({ objectType: recyclableObjectTypeSchema, id: z.uuid() })
  .strict();

export type RecycleBinParams = z.infer<typeof recycleBinParamsSchema>;

/**
 * One deleted record, as the Bin lists it.
 *
 * Deliberately **not** the record's serialized body. The Bin's job is to let
 * someone find a record they deleted and put it back; showing every field of
 * every deleted record would mean running five serializers over five row types
 * and re-deriving field permissions for each, for a screen whose only question
 * is "is this the one?". `label` is built from the fields this reader may read,
 * so it is not a way around field permissions either.
 */
export const recycleBinEntrySchema = z.object({
  objectType: recyclableObjectTypeSchema,
  id: z.uuid(),
  /** Built only from fields the reader may read; falls back to the object name. */
  label: z.string(),
  ownerId: z.uuid().nullable(),
  deletedAt: z.iso.datetime({ offset: true }),
  /** When the purge job will remove it for good. */
  purgeAfter: z.iso.datetime({ offset: true }),
  /** Needed by the restore call, which carries it like every other write. */
  version: z.number().int(),
});

export type RecycleBinEntry = z.infer<typeof recycleBinEntrySchema>;

/**
 * Restore carries the version, exactly as an update and a delete do.
 *
 * It is a state change on a record someone else may also be acting on, and the
 * same optimistic lock applies: restoring a record whose row has moved since
 * the Bin was listed fails loudly rather than overwriting.
 */
export const recycleBinRestoreSchema = z.object({ version: z.number().int().min(1) }).strict();

export type RecycleBinRestoreInput = z.infer<typeof recycleBinRestoreSchema>;

export const recycleBinRestoredSchema = z.object({
  objectType: recyclableObjectTypeSchema,
  id: z.uuid(),
  version: z.number().int(),
});
