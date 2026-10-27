import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  pipelineParamsSchema,
  pipelineStageParamsSchema,
  stageArchiveSchema,
  stageCreateSchema,
  stageOrderSchema,
  stageRestoreSchema,
  stageUpdateSchema,
  type PipelineParams,
  type PipelineStageParams,
  type StageArchiveInput,
  type StageCreateInput,
  type StageOrderInput,
  type StageRestoreInput,
  type StageUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { PipelineEditorService } from './pipeline-editor.service.js';

/**
 * `/api/v1/pipelines/manage` and `/api/v1/pipelines/:pipelineId/stages/...` (ADR-0007, ADR-0062).
 *
 * Validate, hand off, wrap in the envelope. Who may edit a pipeline is decided in the service by
 * `can()` on the `pipeline` object; no route takes a company or a user.
 */
@Controller('pipelines')
export class PipelineEditorController {
  constructor(@Inject(PipelineEditorService) private readonly editor: PipelineEditorService) {}

  @Get('manage')
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.editor.list(actor) };
  }

  @Post(':pipelineId/stages')
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(pipelineParamsSchema)) params: PipelineParams,
    @Body(zodPipe(stageCreateSchema)) body: StageCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.editor.createStage(
        actor,
        params.pipelineId,
        body,
        parseIdempotencyKey(idempotencyKey),
      ),
    };
  }

  /** Declared before `:stageId`, or `order` would be read as a stage id. */
  @Post(':pipelineId/stages/order')
  @HttpCode(200)
  async order(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(pipelineParamsSchema)) params: PipelineParams,
    @Body(zodPipe(stageOrderSchema)) body: StageOrderInput,
  ) {
    return { data: await this.editor.orderStages(actor, params.pipelineId, body) };
  }

  @Patch(':pipelineId/stages/:stageId')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(pipelineStageParamsSchema)) params: PipelineStageParams,
    @Body(zodPipe(stageUpdateSchema)) body: StageUpdateInput,
  ) {
    return {
      data: await this.editor.updateStage(actor, params.pipelineId, params.stageId, body),
    };
  }

  @Post(':pipelineId/stages/:stageId/archive')
  @HttpCode(200)
  async archive(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(pipelineStageParamsSchema)) params: PipelineStageParams,
    @Body(zodPipe(stageArchiveSchema)) body: StageArchiveInput,
  ) {
    return {
      data: await this.editor.archiveStage(actor, params.pipelineId, params.stageId, body),
    };
  }

  @Post(':pipelineId/stages/:stageId/restore')
  @HttpCode(200)
  async restore(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(pipelineStageParamsSchema)) params: PipelineStageParams,
    @Body(zodPipe(stageRestoreSchema)) body: StageRestoreInput,
  ) {
    return {
      data: await this.editor.restoreStage(actor, params.pipelineId, params.stageId, body),
    };
  }
}
