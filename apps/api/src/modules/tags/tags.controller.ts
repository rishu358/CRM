import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  tagDeleteQuerySchema,
  tagParamsSchema,
  tagUpdateSchema,
  type TagDeleteQuery,
  type TagUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { TagsService } from './tags.service.js';

/**
 * `/api/v1/tags` (ADR-0007, ADR-0063).
 *
 * Validate, hand off, wrap in the envelope. Who may manage tags is decided in the service.
 */
@Controller('tags')
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.tags.list(actor) };
  }

  /** Declared before `:id` so `usage` is never read as an id. */
  @Get('usage')
  async usage(@CurrentActor() actor: Actor) {
    return { data: await this.tags.usage(actor) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(tagParamsSchema)) params: { id: string },
    @Body(zodPipe(tagUpdateSchema)) body: TagUpdateInput,
  ) {
    return { data: await this.tags.update(actor, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(tagParamsSchema)) params: { id: string },
    @Query(zodPipe(tagDeleteQuerySchema)) query: TagDeleteQuery,
  ): Promise<void> {
    await this.tags.remove(actor, params.id, query.version);
  }
}
