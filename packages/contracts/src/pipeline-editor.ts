import { MAX_STAGES_PER_PIPELINE, STAGE_NAME_MAX_LENGTH } from '@crm/core';
import { z } from 'zod';
import { stageTypeSchema } from './deals.js';

/**
 * The pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
 *
 * Every write returns the whole pipeline as the editor sees it afterwards, so
 * the screen redraws from one answer rather than patching its own copy. Every
 * request body is `.strict()`: an unknown key is a 422, not ignored.
 *
 * Sizes are the constants in `@crm/core`, so the screen, the API and the tests
 * share one number.
 */

export { MAX_STAGES_PER_PIPELINE, STAGE_NAME_MAX_LENGTH };

const stageNameSchema = z
  .string()
  .trim()
  .min(1, 'A stage needs a name')
  .max(STAGE_NAME_MAX_LENGTH, `A stage name is at most ${STAGE_NAME_MAX_LENGTH} characters`);

const probabilitySchema = z.number().int().min(0).max(100);

/** One stage as the editor shows it: in use, or retired, with what sits in it. */
export const managedStageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  probability: z.number().int(),
  stageType: stageTypeSchema,
  version: z.number().int(),
  /** Null while the stage is in use; when it was retired otherwise. */
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Deals in this stage that are not in the Recycle Bin. */
  dealCount: z.number().int(),
  /** Deals in this stage that are in the Recycle Bin; they move too when the stage is retired. */
  recycleBinDealCount: z.number().int(),
});
export type ManagedStage = z.infer<typeof managedStageSchema>;

export const managedPipelineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  isDefault: z.boolean(),
  /** Changes whenever the set or the order of the stages does. */
  version: z.number().int(),
  /** In use first, in board order; then the retired ones, most recently retired first. */
  stages: z.array(managedStageSchema),
});
export type ManagedPipeline = z.infer<typeof managedPipelineSchema>;

export const pipelineStageParamsSchema = z
  .object({ pipelineId: z.uuid(), stageId: z.uuid() })
  .strict();
export type PipelineStageParams = z.infer<typeof pipelineStageParamsSchema>;

export const pipelineParamsSchema = z.object({ pipelineId: z.uuid() }).strict();
export type PipelineParams = z.infer<typeof pipelineParamsSchema>;

export const stageCreateSchema = z
  .object({
    name: stageNameSchema,
    stageType: stageTypeSchema.default('open'),
    /**
     * Omitted: 0 on a lost stage, 100 on a won one, and 50 on an open one. A won stage can only be
     * 100 and a lost stage only 0, so any other number there is refused.
     */
    probability: probabilitySchema.optional(),
  })
  .strict();
export type StageCreateInput = z.infer<typeof stageCreateSchema>;

export const stageUpdateSchema = z
  .object({
    /** The stage's `version` as the editor last read it. */
    version: z.number().int().positive(),
    name: stageNameSchema.optional(),
    probability: probabilitySchema.optional(),
    /**
     * Only while no deal, live or in the Recycle Bin, has ever been in the stage; otherwise 422.
     * Retyping a stage that holds deals would change what those deals mean.
     */
    stageType: stageTypeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.probability !== undefined || value.stageType !== undefined,
    { message: 'Change at least one of name, probability or stageType' },
  );
export type StageUpdateInput = z.infer<typeof stageUpdateSchema>;

export const stageOrderSchema = z
  .object({
    /** The pipeline's `version` as the editor last read it. */
    version: z.number().int().positive(),
    /** Every stage in use, once, first to last. */
    stageIds: z.array(z.uuid()).min(1).max(MAX_STAGES_PER_PIPELINE),
  })
  .strict();
export type StageOrderInput = z.infer<typeof stageOrderSchema>;

export const stageArchiveSchema = z
  .object({
    version: z.number().int().positive(),
    /**
     * Required when the stage holds deals (live or in the Recycle Bin): another stage of the same
     * pipeline and the same type, in use. Every deal moves there in the same transaction.
     */
    moveDealsToStageId: z.uuid().optional(),
  })
  .strict();
export type StageArchiveInput = z.infer<typeof stageArchiveSchema>;

export const stageRestoreSchema = z.object({ version: z.number().int().positive() }).strict();
export type StageRestoreInput = z.infer<typeof stageRestoreSchema>;

/** What retiring a stage did. */
export const stageArchiveResultSchema = z.object({
  pipeline: managedPipelineSchema,
  /** Live deals moved. */
  movedDeals: z.number().int(),
  /** Deals in the Recycle Bin moved with them, so a restore lands somewhere that exists. */
  movedRecycleBinDeals: z.number().int(),
});
export type StageArchiveResult = z.infer<typeof stageArchiveResultSchema>;
