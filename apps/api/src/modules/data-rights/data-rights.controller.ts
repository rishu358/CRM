import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  dataExportCreateSchema,
  dataExportParamsSchema,
  erasureCreateSchema,
  erasureListQuerySchema,
  erasureParamsSchema,
  type DataExportCreateInput,
  type ErasureCreateInput,
  type ErasureListQuery,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { DataRightsService } from './data-rights.service.js';

/**
 * `/api/v1/data-exports` and `/api/v1/erasure-requests` (ADR-0007).
 *
 * Two resources in one controller because they are two halves of the same
 * obligation — show me my data, and delete my data — and a client that
 * implements one implements the other. Each endpoint's capability is checked in
 * the service, not here.
 */
@Controller()
export class DataRightsController {
  constructor(@Inject(DataRightsService) private readonly dataRights: DataRightsService) {}

  @Post('data-exports')
  @HttpCode(202)
  async createExport(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(dataExportCreateSchema)) body: DataExportCreateInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return {
      data: await this.dataRights.createExport(actor, body, parseIdempotencyKey(idempotencyKey)),
    };
  }

  @Get('data-exports/:id')
  async getExport(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(dataExportParamsSchema)) params: { id: string },
  ) {
    return { data: await this.dataRights.getExport(actor, params.id) };
  }

  /** A POST because handing out the link is the moment the data leaves. */
  @Post('data-exports/:id/download')
  @HttpCode(200)
  async downloadLink(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(dataExportParamsSchema)) params: { id: string },
  ) {
    return { data: await this.dataRights.downloadLink(actor, params.id) };
  }

  @Post('erasure-requests')
  @HttpCode(202)
  async createErasure(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(erasureCreateSchema)) body: ErasureCreateInput,
  ) {
    return { data: await this.dataRights.createErasure(actor, body) };
  }

  @Get('erasure-requests')
  async listErasures(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(erasureListQuerySchema)) query: ErasureListQuery,
  ) {
    return this.dataRights.listErasures(actor, query);
  }

  @Get('erasure-requests/:id')
  async getErasure(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(erasureParamsSchema)) params: { id: string },
  ) {
    return { data: await this.dataRights.getErasure(actor, params.id) };
  }
}
