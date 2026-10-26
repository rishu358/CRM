import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { reassignSchema, type ReassignInput } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { OwnershipService } from './ownership.service.js';

/** `/api/v1/ownership` (ADR-0007). */
@Controller('ownership')
export class OwnershipController {
  constructor(@Inject(OwnershipService) private readonly ownership: OwnershipService) {}

  @Post('preview')
  @HttpCode(200)
  async preview(@CurrentActor() actor: Actor, @Body(zodPipe(reassignSchema)) body: ReassignInput) {
    return { data: await this.ownership.preview(actor, body) };
  }

  @Post('reassign')
  @HttpCode(200)
  async reassign(@CurrentActor() actor: Actor, @Body(zodPipe(reassignSchema)) body: ReassignInput) {
    return { data: await this.ownership.reassign(actor, body) };
  }
}
