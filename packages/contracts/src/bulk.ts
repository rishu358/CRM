import {
  BULK_MAX_RECORDS,
  BULK_MAX_TAGS,
  BULK_SKIP_REASONS,
  BUSINESS_OBJECT_TYPES,
  isValidTagName,
  normalizeTagName,
  TAG_NAME_MAX,
} from '@crm/core';
import { z } from 'zod';
import { viewFiltersSchema } from './saved-views.js';

/**
 * Bulk action contracts (MVP_SPEC M3 and M4, ADR-0056).
 *
 * One endpoint, one request shape: *which records* (`target`), *what to do to them* (`action`).
 * Both halves are closed unions, so an unknown key or an unknown action is a 422 and not something
 * quietly ignored (CLAUDE.md §5.6).
 *
 * The request never carries a tenant, an owner for the audit trail or a role: those come from the
 * session. It carries the object type because the same four lists need the same four actions.
 */

export const bulkObjectTypeSchema = z.enum(BUSINESS_OBJECT_TYPES);
export type BulkObjectType = z.infer<typeof bulkObjectTypeSchema>;

/**
 * The records to act on.
 *
 * `ids`: exactly those records, up to the cap. `filter`: whatever a list's search and conditions
 * match **for this caller**, a batch at a time in id order. A response carries `nextCursor` when
 * more match, and the caller sends it back as `after` until it is `null`. The cap holds either
 * way: one request never touches more than `BULK_MAX_RECORDS`.
 */
export const bulkTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ids'),
      ids: z.array(z.uuid()).min(1).max(BULK_MAX_RECORDS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('filter'),
      filter: viewFiltersSchema,
      /** The `nextCursor` of the previous response; omitted for the first batch. */
      after: z.uuid().optional(),
    })
    .strict(),
]);
export type BulkTarget = z.infer<typeof bulkTargetSchema>;

const tagNameSchema = z
  .string()
  .transform(normalizeTagName)
  .refine(isValidTagName, `Use 1 to ${TAG_NAME_MAX} characters on one line`);

const tagsSchema = z
  .array(tagNameSchema)
  .min(1)
  .max(BULK_MAX_TAGS)
  .refine((names) => new Set(names.map((name) => name.toLowerCase())).size === names.length, {
    message: 'Name each tag once',
  });

const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use a field key');

const common = {
  objectType: bulkObjectTypeSchema,
  target: bulkTargetSchema,
  /** Run it, report what it would do, change nothing. */
  dryRun: z.boolean().default(false),
};

export const bulkActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('edit'),
      /**
       * Field key to the new value, for the fields the object lets a bulk edit change plus any
       * active custom field. `null` clears a field. Which keys are allowed is decided by the
       * service from the allowlist and the field metadata, then each value by the same schema a
       * single edit uses.
       */
      changes: z
        .record(fieldKeySchema, z.unknown())
        .refine((changes) => Object.keys(changes).length >= 1, 'Change at least one field')
        .refine((changes) => Object.keys(changes).length <= 20, 'Change at most 20 fields'),
    })
    .strict(),
  z.object({ ...common, action: z.literal('assign'), ownerId: z.uuid() }).strict(),
  z.object({ ...common, action: z.literal('delete') }).strict(),
  z.object({ ...common, action: z.literal('tag_add'), tags: tagsSchema }).strict(),
  z.object({ ...common, action: z.literal('tag_remove'), tags: tagsSchema }).strict(),
]);
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
export type BulkActionName = BulkActionInput['action'];

export const bulkSkippedSchema = z.object({
  /** An id the caller named, or one their filter matched. Never an id they did not supply or match. */
  id: z.uuid(),
  reason: z.enum(BULK_SKIP_REASONS),
  /** For `invalid` only: what is wrong, in words a person can act on. */
  message: z.string().optional(),
});
export type BulkSkipped = z.infer<typeof bulkSkippedSchema>;

export const bulkResultSchema = z.object({
  objectType: bulkObjectTypeSchema,
  action: z.enum(['edit', 'assign', 'delete', 'tag_add', 'tag_remove']),
  dryRun: z.boolean(),
  /** Records this call looked at: the ids named, or the batch the filter matched. */
  matched: z.number().int(),
  /** Records changed (or, on a dry run, that would be). */
  changed: z.number().int(),
  changedIds: z.array(z.uuid()),
  skipped: z.array(bulkSkippedSchema),
  /** A filter target that matched more than one batch: send this back as `after`. */
  nextCursor: z.uuid().nullable(),
  /** True when this is the stored answer to a retried Idempotency-Key, not a fresh run. */
  replayed: z.boolean(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

export const tagSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
});
export type Tag = z.infer<typeof tagSchema>;
