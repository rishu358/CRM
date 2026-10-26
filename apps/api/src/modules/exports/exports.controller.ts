import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { exportCreateSchema, exportParamsSchema, type ExportCreateInput } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { ExportsService } from './exports.service.js';

/**
 * `/api/v1/exports` (ADR-0007, MVP_SPEC §M8).
 *
 * Download is a **POST that returns a link**, not a GET that returns a file.
 * Two reasons, both deliberate: the file must never stream through this
 * process (CLAUDE.md §5.12), and handing out the link is the moment the data
 * leaves the building, which is an audited event — and a GET that writes an
 * audit row is a GET that prefetchers and link scanners would trigger.
 */
@Controller('exports')
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(exportCreateSchema)) body: ExportCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.exports.create(actor, body, parseIdempotencyKey(idempotencyKey)) };
  }

  @Get(':id')
  async get(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(exportParamsSchema)) params: { id: string },
  ) {
    return { data: await this.exports.get(actor, params.id) };
  }

  @Post(':id/download')
  @HttpCode(200)
  async download(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(exportParamsSchema)) params: { id: string },
  ) {
    return { data: await this.exports.downloadLink(actor, params.id) };
  }
}
