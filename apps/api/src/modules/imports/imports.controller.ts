import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  importCreateSchema,
  importListQuerySchema,
  importParamsSchema,
  importStartSchema,
  type ImportCreateInput,
  type ImportListQuery,
  type ImportStartInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { ImportsService } from './imports.service.js';

/**
 * `/api/v1/imports` (ADR-0007, MVP_SPEC §M8).
 *
 * Validate, hand off, envelope. **There is no endpoint here that accepts a
 * file**, and that is the design rather than an omission: the browser uploads
 * to object storage on a presigned URL and the API never sees the bytes
 * (CLAUDE.md §5.12).
 */
@Controller('imports')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(importCreateSchema)) body: ImportCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.imports.create(actor, body, parseIdempotencyKey(idempotencyKey)) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(importListQuerySchema)) query: ImportListQuery,
  ) {
    return this.imports.list(actor, query);
  }

  @Get(':id')
  async get(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(importParamsSchema)) params: { id: string },
  ) {
    return { data: await this.imports.get(actor, params.id) };
  }

  @Post(':id/uploaded')
  @HttpCode(202)
  async uploaded(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(importParamsSchema)) params: { id: string },
  ) {
    return { data: await this.imports.confirmUploaded(actor, params.id) };
  }

  @Post(':id/start')
  @HttpCode(202)
  async start(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(importParamsSchema)) params: { id: string },
    @Body(zodPipe(importStartSchema)) body: ImportStartInput,
  ) {
    return { data: await this.imports.start(actor, params.id, body) };
  }

  /** The same body as `start`; imports nothing. The answer is a job to watch, like `start`'s. */
  @Post(':id/check')
  @HttpCode(202)
  async check(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(importParamsSchema)) params: { id: string },
    @Body(zodPipe(importStartSchema)) body: ImportStartInput,
  ) {
    return { data: await this.imports.check(actor, params.id, body) };
  }

  @Post(':id/error-file')
  @HttpCode(200)
  async errorFile(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(importParamsSchema)) params: { id: string },
  ) {
    return { data: await this.imports.errorFileLink(actor, params.id) };
  }
}
