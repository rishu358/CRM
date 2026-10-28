import { MERGE_CHOICES, MERGEABLE_OBJECT_TYPES } from '@crm/core';
import { z } from 'zod';

/**
 * Record merge contracts (MVP_SPEC M4, ADR-0064).
 *
 * One request folds one record (the loser) into another (the master). It never carries a tenant, an
 * owner or a role: those come from the session. It carries both versions, because a merge that
 * overwrites a colleague's edit of either record is the one thing a merge must not do.
 *
 * `fields` says, for any field where the loser's value should win, `loser`; every field not named keeps
 * the master's. Which keys are real, readable and writable is decided by the service against the
 * object's field metadata and the caller's field permissions, as for an edit: a schema cannot know a
 * tenant's custom fields.
 */

export const mergeObjectTypeSchema = z.enum(MERGEABLE_OBJECT_TYPES);
export type MergeObjectType = z.infer<typeof mergeObjectTypeSchema>;

const fieldKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/, 'Use a field key');

export const mergeRequestSchema = z
  .object({
    objectType: mergeObjectTypeSchema,
    /** The record that stays. */
    masterId: z.uuid(),
    masterVersion: z.number().int().positive(),
    /** The duplicate that is folded into it, and then goes to the Recycle Bin. */
    loserId: z.uuid(),
    loserVersion: z.number().int().positive(),
    /** Field key to the record whose value wins; a field not named keeps the master's. */
    fields: z
      .record(fieldKeySchema, z.enum(MERGE_CHOICES))
      .default({})
      .refine((fields) => Object.keys(fields).length <= 80, 'Name at most 80 fields'),
    /** Run everything, report what would happen, change nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type MergeRequestInput = z.infer<typeof mergeRequestSchema>;

/** What moves, per kind; `null` is a kind the caller may not read, so is not counted for them. */
export const mergeCountsSchema = z.object({
  activities: z.number().int().nullable(),
  notes: z.number().int().nullable(),
  files: z.number().int(),
  deals: z.number().int().nullable(),
  contacts: z.number().int().nullable(),
  childAccounts: z.number().int().nullable(),
  leads: z.number().int().nullable(),
  tags: z.number().int(),
});
export type MergeCountsView = z.infer<typeof mergeCountsSchema>;

export const mergeResultSchema = z.object({
  objectType: mergeObjectTypeSchema,
  masterId: z.uuid(),
  loserId: z.uuid(),
  dryRun: z.boolean(),
  /** What moved (or, on a dry run, would). Only kinds the caller may read are counted. */
  counts: mergeCountsSchema,
  /** The field keys whose value came from the loser. */
  fromLoser: z.array(z.string()),
  /** The merged record, as the caller may read it: a field they may not read is absent, as on a GET. */
  record: z.record(z.string(), z.unknown()),
  /** True when this is the stored answer to a retried Idempotency-Key, not a fresh run. */
  replayed: z.boolean(),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;
