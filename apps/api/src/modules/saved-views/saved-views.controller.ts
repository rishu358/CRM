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
  savedViewCreateSchema,
  savedViewDeleteQuerySchema,
  savedViewListQuerySchema,
  savedViewParamsSchema,
  savedViewUpdateSchema,
  type SavedViewCreateInput,
  type SavedViewDeleteQuery,
  type SavedViewListQuery,
  type SavedViewUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { SavedViewsService } from './saved-views.service.js';

/**
 * `/api/v1/saved-views` (ADR-0007, ADR-0056).
 *
 * Validate, hand off, wrap in the envelope. Authorization, visibility and field permissions live
 * in the service, so every client gets them.
 */
@Controller('saved-views')
export class SavedViewsController {
  constructor(@Inject(SavedViewsService) private readonly views: SavedViewsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(savedViewListQuerySchema)) query: SavedViewListQuery,
  ) {
    return { data: await this.views.list(actor, query) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(savedViewCreateSchema)) body: SavedViewCreateInput,
  ) {
    return { data: await this.views.create(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(savedViewParamsSchema)) params: { id: string },
    @Body(zodPipe(savedViewUpdateSchema)) body: SavedViewUpdateInput,
  ) {
    return { data: await this.views.update(actor, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(savedViewParamsSchema)) params: { id: string },
    @Query(zodPipe(savedViewDeleteQuerySchema)) query: SavedViewDeleteQuery,
  ): Promise<void> {
    await this.views.remove(actor, params.id, query.version);
  }
}
