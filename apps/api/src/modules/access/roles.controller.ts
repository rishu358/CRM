import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  permissionApplySchema,
  permissionPatchSchema,
  roleCreateSchema,
  roleParamsSchema,
  roleUpdateSchema,
  type PermissionApplyInput,
  type PermissionPatch,
  type RoleCreateInput,
  type RoleUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { RolesService } from './roles.service.js';

/** `/api/v1/roles` (ADR-0007). Authorization lives in the service, via `can()`. */
@Controller('roles')
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.roles.list(actor) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(roleCreateSchema)) body: RoleCreateInput,
  ) {
    return { data: await this.roles.create(actor, body) };
  }

  @Get(':id')
  async get(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(roleParamsSchema)) params: { id: string },
  ) {
    return { data: await this.roles.get(actor, params.id) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(roleParamsSchema)) params: { id: string },
    @Body(zodPipe(roleUpdateSchema)) body: RoleUpdateInput,
  ) {
    return { data: await this.roles.update(actor, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(roleParamsSchema)) params: { id: string },
  ): Promise<void> {
    await this.roles.remove(actor, params.id);
  }

  /** A POST, so a preview can never be mistaken for a save. */
  @Post(':id/permissions/preview')
  @HttpCode(200)
  async preview(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(roleParamsSchema)) params: { id: string },
    @Body(zodPipe(permissionPatchSchema)) body: PermissionPatch,
  ) {
    return { data: await this.roles.preview(actor, params.id, body) };
  }

  @Patch(':id/permissions')
  async apply(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(roleParamsSchema)) params: { id: string },
    @Body(zodPipe(permissionApplySchema)) body: PermissionApplyInput,
  ) {
    return { data: await this.roles.apply(actor, params.id, body) };
  }
}
