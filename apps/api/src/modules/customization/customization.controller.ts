import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  fieldCreateSchema,
  fieldListQuerySchema,
  fieldOrderSchema,
  fieldParamsSchema,
  fieldUpdateSchema,
  type FieldCreateInput,
  type FieldListQuery,
  type FieldOrderInput,
  type FieldUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { CustomizationService } from './customization.service.js';

/**
 * `/api/v1/fields` (ADR-0007, ADR-0039).
 *
 * Validate, hand off, wrap in the envelope. Who may read which definitions and who
 * may change them is decided in the service; no route takes a company or a user.
 */
@Controller('fields')
export class CustomizationController {
  constructor(@Inject(CustomizationService) private readonly fields: CustomizationService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(fieldListQuerySchema)) query: FieldListQuery,
  ) {
    return { data: await this.fields.list(actor, query) };
  }

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(fieldCreateSchema)) body: FieldCreateInput,
  ) {
    return { data: await this.fields.create(actor, body) };
  }

  /** Declared before `:id`, or `order` would be read as a field id. */
  @Post('order')
  @HttpCode(200)
  async order(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(fieldOrderSchema)) body: FieldOrderInput,
  ) {
    return { data: await this.fields.order(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(fieldParamsSchema)) params: { id: string },
    @Body(zodPipe(fieldUpdateSchema)) body: FieldUpdateInput,
  ) {
    return { data: await this.fields.update(actor, params.id, body) };
  }
}
