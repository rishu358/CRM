import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { bulkActionSchema, type BulkActionInput } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { BulkService } from './bulk.service.js';

/**
 * `/api/v1/bulk-actions` (ADR-0007, ADR-0056). The workspace's tags moved to the tags module (ADR-0063).
 *
 * A POST that **changes records and answers 200**, not 201 or 202: it does the work in the
 * request, and what it returns is the account of what was done (and skipped), not a new resource.
 */
@Controller()
export class BulkController {
  constructor(@Inject(BulkService) private readonly bulk: BulkService) {}

  @Post('bulk-actions')
  @HttpCode(200)
  async run(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(bulkActionSchema)) body: BulkActionInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.bulk.run(actor, body, parseIdempotencyKey(idempotencyKey)) };
  }
}
