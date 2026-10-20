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
} from '@nestjs/common';
import {
  teamCreateSchema,
  teamMembersSchema,
  teamParamsSchema,
  teamUpdateSchema,
  type TeamCreateInput,
  type TeamMembersInput,
  type TeamUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { TeamsService } from './teams.service.js';

/** `/api/v1/teams` (ADR-0007). */
@Controller('teams')
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.teams.list(actor) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(teamCreateSchema)) body: TeamCreateInput,
  ) {
    return { data: await this.teams.create(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(teamParamsSchema)) params: { id: string },
    @Body(zodPipe(teamUpdateSchema)) body: TeamUpdateInput,
  ) {
    return { data: await this.teams.update(actor, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(teamParamsSchema)) params: { id: string },
  ): Promise<void> {
    await this.teams.remove(actor, params.id);
  }

  @Patch(':id/members')
  async setMembers(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(teamParamsSchema)) params: { id: string },
    @Body(zodPipe(teamMembersSchema)) body: TeamMembersInput,
  ) {
    return { data: await this.teams.setMembers(actor, params.id, body) };
  }
}
