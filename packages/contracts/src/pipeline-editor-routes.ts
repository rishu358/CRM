import { ErrorCode } from '@crm/core';
import {
  managedPipelineSchema,
  pipelineParamsSchema,
  pipelineStageParamsSchema,
  stageArchiveResultSchema,
  stageArchiveSchema,
  stageCreateSchema,
  stageOrderSchema,
  stageRestoreSchema,
  stageUpdateSchema,
} from './pipeline-editor.js';
import type { RouteDefinition } from './routes.js';

const VERSIONED: readonly ErrorCode[] = [ErrorCode.NOT_FOUND, ErrorCode.VERSION_CONFLICT];

/** What a route that accepts an `Idempotency-Key` can answer on top of its own errors (ADR-0060). */
const IDEMPOTENT: readonly ErrorCode[] = [
  ErrorCode.IDEMPOTENCY_KEY_REUSED,
  ErrorCode.IDEMPOTENCY_IN_PROGRESS,
  ErrorCode.IDEMPOTENT_RECORD_UNAVAILABLE,
];

const PIPELINE_EDITOR_NOTE =
  'Needs the `pipeline` grant for the action (`read` to look, `create` to add a stage, `update` to ' +
  'rename, re-weight, retype or reorder, `delete` to retire one); Owner and Admin have all four. ' +
  'Answers the whole pipeline as the editor sees it afterwards, so a screen redraws from one answer. ' +
  'A pipeline always keeps one open, one won and one lost stage in use, open stages first, at most ' +
  '20 in all (ADR-0062).';

/**
 * The pipeline and stage editor's routes (MVP_SPEC M5, M9; ADR-0062), kept beside their schemas
 * and spread into `API_ROUTES`.
 */
export const pipelineEditorRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/pipelines/manage',
    operationId: 'listManagedPipelines',
    tag: 'Pipelines',
    summary: 'Pipelines with every stage, retired ones included, and the deals in each',
    description:
      'What the editor draws: stages in use in board order, then retired ones, each with its ' +
      '`version`, how many deals sit in it and how many of those are in the Recycle Bin. ' +
      'Needs `read` on `pipeline`; the board itself uses `GET /pipelines`, which needs only ' +
      'deal read access and lists stages in use. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'ManagedPipelineListResponse',
      description: 'The pipelines.',
      data: managedPipelineSchema.array(),
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/pipelines/{pipelineId}/stages',
    operationId: 'createPipelineStage',
    tag: 'Pipelines',
    summary: 'Add a stage',
    description:
      'A new open stage goes after the last open stage; a new won or lost stage goes last. ' +
      'The name is trimmed and unique within the pipeline ignoring case. A won stage is at ' +
      '100% and a lost stage at 0%. Accepts an `Idempotency-Key` header: a retry returns the ' +
      'pipeline as it is now and adds no second stage. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    params: pipelineParamsSchema,
    body: { name: 'StageCreate', schema: stageCreateSchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'StageCreateResponse',
      description: 'The pipeline after the change.',
      data: managedPipelineSchema,
    },
    errors: [ErrorCode.NOT_FOUND, ErrorCode.CONFLICT, ...IDEMPOTENT],
  },
  {
    method: 'PATCH',
    path: '/pipelines/{pipelineId}/stages/{stageId}',
    operationId: 'updatePipelineStage',
    tag: 'Pipelines',
    summary: 'Rename a stage, change its probability, or retype it',
    description:
      'Carries the stage `version`; a stale one is a 409. Changing the type is refused while any ' +
      'deal, live or in the Recycle Bin, is in the stage, because it would change what those ' +
      'deals mean. Renaming never rewrites history: past timeline entries keep the name they ' +
      'were written with. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    params: pipelineStageParamsSchema,
    body: { name: 'StageUpdate', schema: stageUpdateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'StageUpdateResponse',
      description: 'The pipeline after the change.',
      data: managedPipelineSchema,
    },
    errors: [...VERSIONED, ErrorCode.CONFLICT],
  },
  {
    method: 'POST',
    path: '/pipelines/{pipelineId}/stages/order',
    operationId: 'orderPipelineStages',
    tag: 'Pipelines',
    summary: 'Set the order of the stages in use',
    description:
      'Names every stage in use, first to last, with the pipeline `version`: a list that leaves ' +
      'one out, repeats one or names a retired or foreign one is refused, and so is a stale ' +
      'version (409). All or nothing, in one transaction; two reorders at once are applied one ' +
      'after the other and never leave two stages in one place. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    params: pipelineParamsSchema,
    body: { name: 'StageOrder', schema: stageOrderSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'StageOrderResponse',
      description: 'The pipeline after the change.',
      data: managedPipelineSchema,
    },
    errors: VERSIONED,
  },
  {
    method: 'POST',
    path: '/pipelines/{pipelineId}/stages/{stageId}/archive',
    operationId: 'archivePipelineStage',
    tag: 'Pipelines',
    summary: 'Retire a stage, moving its deals first',
    description:
      'A stage is retired, never deleted: its row, its history and its past timeline entries ' +
      'stay. If it holds deals (live or in the Recycle Bin) the request must name ' +
      '`moveDealsToStageId`, another stage in use in the same pipeline and of the same type: ' +
      'open to open, won to won, lost to lost. Every deal is moved in the same transaction by ' +
      'the same rules as a drag on the board, with an audit entry and a `deal.stage_changed` ' +
      'event each; won and lost deals keep the date they closed and their lost reason. At most ' +
      '2000 deals at a time. The last open, won or lost stage in use cannot be retired. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    params: pipelineStageParamsSchema,
    body: { name: 'StageArchive', schema: stageArchiveSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'StageArchiveResponse',
      description: 'The pipeline after the change, and how many deals moved.',
      data: stageArchiveResultSchema,
    },
    errors: VERSIONED,
  },
  {
    method: 'POST',
    path: '/pipelines/{pipelineId}/stages/{stageId}/restore',
    operationId: 'restorePipelineStage',
    tag: 'Pipelines',
    summary: 'Bring a retired stage back',
    description:
      'The stage comes back empty, placed by the same rule as a new stage of its type. It is ' +
      'refused (409) if another stage in use now has its name. ' +
      PIPELINE_EDITOR_NOTE,
    auth: 'session',
    params: pipelineStageParamsSchema,
    body: { name: 'StageRestore', schema: stageRestoreSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'StageRestoreResponse',
      description: 'The pipeline after the change.',
      data: managedPipelineSchema,
    },
    errors: [...VERSIONED, ErrorCode.CONFLICT],
  },
];
