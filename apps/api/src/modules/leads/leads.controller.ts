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
  duplicateCheckSchema,
  leadConvertSchema,
  leadCreateSchema,
  leadDeleteQuerySchema,
  leadListQuerySchema,
  leadParamsSchema,
  leadUpdateSchema,
  type DuplicateCheckInput,
  type LeadConvertRequest,
  type LeadCreateInput,
  type LeadDeleteQuery,
  type LeadListQuery,
  type LeadUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { LeadsService } from './leads.service.js';

/**
 * `/api/v1/leads` (ADR-0007).
 *
 * The controller does three things and nothing else: validate with Zod, hand
 * off to the service, wrap the result in the response envelope. Authorization,
 * tenancy and field permissions all live in the service and the serializer, so
 * the public API and a future mobile client get them for free rather than
 * depending on a controller remembering to check.
 */
@Controller('leads')
export class LeadsController {
  constructor(@Inject(LeadsService) private readonly leads: LeadsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(leadListQuerySchema)) query: LeadListQuery,
  ) {
    return this.leads.list(actor, query);
  }

  /**
   * "Would this lead duplicate something?", asked before it is saved.
   *
   * A POST because the question carries an email address and a phone number,
   * which do not belong in a URL (CLAUDE.md §5.8, and every proxy and access
   * log between here and the browser). Nothing is written.
   */
  @Post('duplicate-check')
  @HttpCode(200)
  async checkDuplicates(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(duplicateCheckSchema)) body: DuplicateCheckInput,
  ) {
    return { data: await this.leads.checkDuplicates(actor, body) };
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadParamsSchema)) params: { id: string },
  ) {
    return { data: await this.leads.getById(actor, params.id) };
  }

  /** What converting this lead would duplicate: the "link to existing" choices. */
  @Get(':id/conversion-matches')
  async conversionMatches(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadParamsSchema)) params: { id: string },
  ) {
    return { data: await this.leads.conversionMatches(actor, params.id) };
  }

  /**
   * Created whatever it matches: duplicates are reported in `meta`, never a
   * reason to refuse (MVP_SPEC M4, ADR-0023).
   */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(leadCreateSchema)) body: LeadCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const { lead, duplicates } = await this.leads.create(
      actor,
      body,
      parseIdempotencyKey(idempotencyKey),
    );
    return { data: lead, meta: { duplicates } };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadParamsSchema)) params: { id: string },
    @Body(zodPipe(leadUpdateSchema)) body: LeadUpdateInput,
  ) {
    return { data: await this.leads.update(actor, params.id, body) };
  }

  /**
   * Convert a lead into a contact, an account and, optionally, a deal — all or
   * nothing (ADR-0022). A POST on the lead rather than a PATCH of its status:
   * it is an action with consequences for other records, not an edit.
   */
  @Post(':id/convert')
  @HttpCode(200)
  async convert(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadParamsSchema)) params: { id: string },
    @Body(zodPipe(leadConvertSchema)) body: LeadConvertRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.leads.convert(actor, params.id, body, parseIdempotencyKey(idempotencyKey)),
    };
  }

  /**
   * Soft delete. The version is required for the same reason it is on PATCH:
   * deleting a record someone else has just edited should fail loudly.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadParamsSchema)) params: { id: string },
    @Query(zodPipe(leadDeleteQuerySchema)) query: LeadDeleteQuery,
  ): Promise<void> {
    await this.leads.remove(actor, params.id, query.version);
  }
}
