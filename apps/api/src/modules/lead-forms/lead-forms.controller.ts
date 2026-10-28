import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  leadFormCreateSchema,
  leadFormDeleteQuerySchema,
  leadFormParamsSchema,
  leadFormPauseSchema,
  leadFormRevokeSchema,
  leadFormRotateSchema,
  leadFormUpdateSchema,
  type LeadFormCreateInput,
  type LeadFormDeleteQuery,
  type LeadFormParams,
  type LeadFormPauseInput,
  type LeadFormRevokeInput,
  type LeadFormRotateInput,
  type LeadFormUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { LeadFormsService } from './lead-forms.service.js';

/**
 * `/api/v1/lead-forms` (ADR-0007, ADR-0065): building a website form and managing its keys.
 *
 * Validate, hand off, wrap in the envelope. Who may do what is decided in the service by `can()` on
 * the `lead_form` object; no route takes a workspace or a user. The public side of the feature (what a
 * visitor reaches) is a different controller with a different guard.
 */
@Controller('lead-forms')
export class LeadFormsController {
  constructor(@Inject(LeadFormsService) private readonly forms: LeadFormsService) {}

  /** Declared before `:id`, or `setup` and `pause` would be read as ids. */
  @Get('setup')
  async setup(@CurrentActor() actor: Actor) {
    return { data: await this.forms.setup(actor) };
  }

  @Post('pause')
  @HttpCode(200)
  async pause(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(leadFormPauseSchema)) body: LeadFormPauseInput,
  ) {
    return { data: await this.forms.pause(actor, body.paused) };
  }

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.forms.list(actor) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(leadFormCreateSchema)) body: LeadFormCreateInput,
  ) {
    return { data: await this.forms.create(actor, body) };
  }

  @Get(':id')
  async get(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadFormParamsSchema)) params: LeadFormParams,
  ) {
    return { data: await this.forms.getById(actor, params.id) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadFormParamsSchema)) params: LeadFormParams,
    @Body(zodPipe(leadFormUpdateSchema)) body: LeadFormUpdateInput,
  ) {
    return { data: await this.forms.update(actor, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadFormParamsSchema)) params: LeadFormParams,
    @Query(zodPipe(leadFormDeleteQuerySchema)) query: LeadFormDeleteQuery,
  ): Promise<void> {
    await this.forms.remove(actor, params.id, query.version);
  }

  @Post(':id/key/rotate')
  @HttpCode(200)
  async rotate(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadFormParamsSchema)) params: LeadFormParams,
    @Body(zodPipe(leadFormRotateSchema)) body: LeadFormRotateInput,
  ) {
    return { data: await this.forms.rotateKey(actor, params.id, body) };
  }

  @Post(':id/key/revoke')
  @HttpCode(200)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(leadFormParamsSchema)) params: LeadFormParams,
    @Body(zodPipe(leadFormRevokeSchema)) body: LeadFormRevokeInput,
  ) {
    return { data: await this.forms.revokeKeys(actor, params.id, body) };
  }
}
