import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { mergeRequestSchema, type MergeRequestInput } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { MergeService } from './merge.service.js';

/**
 * `/api/v1/merges` (ADR-0007, ADR-0064).
 *
 * A POST that **changes records and answers 200**, not 201: it creates no resource, it folds one record
 * into another and reports what moved. Validate, hand off, wrap in the envelope; every rule is in the
 * service.
 */
@Controller('merges')
export class MergeController {
  constructor(@Inject(MergeService) private readonly merges: MergeService) {}

  @Post()
  @HttpCode(200)
  async merge(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(mergeRequestSchema)) body: MergeRequestInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.merges.merge(actor, body, parseIdempotencyKey(idempotencyKey)) };
  }
}
