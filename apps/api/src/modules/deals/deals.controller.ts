import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Patch,
  Query,
} from '@nestjs/common';
import {
  dealBoardQuerySchema,
  dealCreateSchema,
  dealDeleteQuerySchema,
  dealListQuerySchema,
  dealParamsSchema,
  dealUpdateSchema,
  type DealBoardQuery,
  type DealCreateInput,
  type DealDeleteQuery,
  type DealListQuery,
  type DealUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { DealsService } from './deals.service.js';

/**
 * `/api/v1/deals` (ADR-0007).
 *
 * The controller does three things and nothing else: validate with Zod, hand
 * off to the service, wrap the result in the response envelope. Authorization,
 * tenancy and field permissions all live in the service and the serializer, so
 * the public API and a future mobile client get them for free rather than
 * depending on a controller remembering to check.
 */
@Controller('deals')
export class DealsController {
  constructor(@Inject(DealsService) private readonly deals: DealsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(dealListQuerySchema)) query: DealListQuery,
  ) {
    return this.deals.list(actor, query);
  }

  /**
   * Declared before `:id`, or `board` would be read as a deal id and refused
   * as a malformed uuid.
   */
  @Get('board')
  async board(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(dealBoardQuerySchema)) query: DealBoardQuery,
  ) {
    return { data: await this.deals.board(actor, query) };
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(dealParamsSchema)) params: { id: string },
  ) {
    return { data: await this.deals.getById(actor, params.id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(dealCreateSchema)) body: DealCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.deals.create(actor, body, parseIdempotencyKey(idempotencyKey)),
    };
  }

  /**
   * Edit, and move: a drag on the board is a PATCH carrying `stageId` and the
   * `version` the card was read at.
   */
  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(dealParamsSchema)) params: { id: string },
    @Body(zodPipe(dealUpdateSchema)) body: DealUpdateInput,
  ) {
    return { data: await this.deals.update(actor, params.id, body) };
  }

  /**
   * Soft delete. The version is required for the same reason it is on PATCH:
   * deleting a record someone else has just edited should fail loudly.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(dealParamsSchema)) params: { id: string },
    @Query(zodPipe(dealDeleteQuerySchema)) query: DealDeleteQuery,
  ): Promise<void> {
    await this.deals.remove(actor, params.id, query.version);
  }
}
