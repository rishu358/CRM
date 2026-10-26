import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  memberListQuerySchema,
  memberParamsSchema,
  memberRolePreviewSchema,
  memberUpdateSchema,
  type MemberListQuery,
  type MemberUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { MembersService } from './members.service.js';

/** `/api/v1/members` (ADR-0007). */
@Controller('members')
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(memberListQuerySchema)) query: MemberListQuery,
  ) {
    return this.members.list(actor, query);
  }

  @Patch(':userId')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(memberParamsSchema)) params: { userId: string },
    @Body(zodPipe(memberUpdateSchema)) body: MemberUpdateInput,
  ) {
    return { data: await this.members.update(actor, params.userId, body) };
  }

  @Post(':userId/role-preview')
  @HttpCode(200)
  async previewRole(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(memberParamsSchema)) params: { userId: string },
    @Body(zodPipe(memberRolePreviewSchema)) body: { roleId: string },
  ) {
    return { data: await this.members.previewRole(actor, params.userId, body.roleId) };
  }
}
