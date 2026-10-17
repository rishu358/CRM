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
  activityCreateSchema,
  activityDeleteQuerySchema,
  activityLinkSchema,
  activityListQuerySchema,
  activityParamsSchema,
  activityUnlinkQuerySchema,
  activityUpdateSchema,
  type ActivityCreateInput,
  type ActivityDeleteQuery,
  type ActivityLinkInput,
  type ActivityListQuery,
  type ActivityUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { ActivitiesService } from './activities.service.js';

/**
 * `/api/v1/activities` (ADR-0007).
 *
 * Validate with Zod, hand off to the service, wrap the result in the response
 * envelope — and nothing else. Authorization, tenancy, link visibility and
 * field permissions all live in the service and the serializer, so the public
 * API and a future mobile client get them without depending on a controller
 * remembering to check.
 */
@Controller('activities')
export class ActivitiesController {
  constructor(@Inject(ActivitiesService) private readonly activities: ActivitiesService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(activityListQuerySchema)) query: ActivityListQuery,
  ) {
    return this.activities.list(actor, query);
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(activityParamsSchema)) params: { id: string },
  ) {
    return { data: await this.activities.getById(actor, params.id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(activityCreateSchema)) body: ActivityCreateInput,
  ) {
    return { data: await this.activities.create(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(activityParamsSchema)) params: { id: string },
    @Body(zodPipe(activityUpdateSchema)) body: ActivityUpdateInput,
  ) {
    return { data: await this.activities.update(actor, params.id, body) };
  }

  /**
   * Attach this activity to another record (ADR-0005).
   *
   * Its own endpoint rather than a field on PATCH: each link is a permission
   * decision about a different record, and a whole-list replacement hides
   * which one was actually meant.
   */
  @Post(':id/links')
  async addLink(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(activityParamsSchema)) params: { id: string },
    @Body(zodPipe(activityLinkSchema)) body: ActivityLinkInput,
  ) {
    return { data: await this.activities.addLink(actor, params.id, body) };
  }

  /** Detach it. The pair is the natural key, so it travels in the query. */
  @Delete(':id/links')
  @HttpCode(204)
  async removeLink(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(activityParamsSchema)) params: { id: string },
    @Query(zodPipe(activityUnlinkQuerySchema)) query: ActivityLinkInput,
  ): Promise<void> {
    await this.activities.removeLink(actor, params.id, query);
  }

  /**
   * Soft delete. The version is required for the same reason it is on PATCH:
   * deleting something someone else has just edited should fail loudly.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(activityParamsSchema)) params: { id: string },
    @Query(zodPipe(activityDeleteQuerySchema)) query: ActivityDeleteQuery,
  ): Promise<void> {
    await this.activities.remove(actor, params.id, query.version);
  }
}
