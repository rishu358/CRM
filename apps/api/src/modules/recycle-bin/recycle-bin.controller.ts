import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  recycleBinListQuerySchema,
  recycleBinParamsSchema,
  recycleBinRestoreSchema,
  type RecycleBinListQuery,
  type RecycleBinParams,
  type RecycleBinRestoreInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { RecycleBinService } from './recycle-bin.service.js';

/**
 * `/api/v1/recycle-bin` (ADR-0007).
 *
 * `objectType` is a path segment on restore and a required query parameter on
 * the list, and in both cases Zod validates it against the closed set before it
 * reaches anything that resolves it to a table name (CLAUDE.md §5.7).
 */
@Controller('recycle-bin')
export class RecycleBinController {
  constructor(@Inject(RecycleBinService) private readonly recycleBin: RecycleBinService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(recycleBinListQuerySchema)) query: RecycleBinListQuery,
  ) {
    return this.recycleBin.list(actor, query);
  }

  /** A POST that changes state but creates nothing, so 200 rather than Nest's 201. */
  @Post(':objectType/:id/restore')
  @HttpCode(200)
  async restore(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(recycleBinParamsSchema)) params: RecycleBinParams,
    @Body(zodPipe(recycleBinRestoreSchema)) body: RecycleBinRestoreInput,
  ) {
    return {
      data: await this.recycleBin.restore(actor, params.objectType, params.id, body.version),
    };
  }
}
