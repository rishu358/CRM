import { Controller, Get, Inject } from '@nestjs/common';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { PipelinesService } from './pipelines.service.js';

/**
 * `/api/v1/pipelines` (ADR-0007).
 *
 * Read-only for now; see `PipelinesService` for why. Authorization and tenancy
 * live in the service, so a client of the public API gets them for free.
 */
@Controller('pipelines')
export class PipelinesController {
  constructor(@Inject(PipelinesService) private readonly pipelines: PipelinesService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.pipelines.list(actor) };
  }
}
