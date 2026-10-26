import { Controller, Get, Inject, Query } from '@nestjs/common';
import { dashboardPipelineQuerySchema, type DashboardPipelineQuery } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { DashboardService } from './dashboard.service.js';

/**
 * `/api/v1/dashboard/*` (ADR-0007, ADR-0038).
 *
 * One route per widget, so a widget the caller may not read is refused on its
 * own and the others still load. Validate, hand off, wrap in the envelope; no
 * route takes a tenant or a user, both come from the session.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get('pipeline')
  async pipeline(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(dashboardPipelineQuerySchema)) query: DashboardPipelineQuery,
  ) {
    return { data: await this.dashboard.pipeline(actor, query) };
  }

  @Get('won')
  async won(@CurrentActor() actor: Actor) {
    return { data: await this.dashboard.won(actor) };
  }

  @Get('leads-by-source')
  async leadsBySource(@CurrentActor() actor: Actor) {
    return { data: await this.dashboard.leadsBySource(actor) };
  }

  @Get('overdue-tasks')
  async overdueTasks(@CurrentActor() actor: Actor) {
    return { data: await this.dashboard.overdueTasks(actor) };
  }

  @Get('leaderboard')
  async leaderboard(@CurrentActor() actor: Actor) {
    return { data: await this.dashboard.leaderboard(actor) };
  }
}
