import { Controller, Get, Inject, Param } from '@nestjs/common';
import {
  reachMemberParamsSchema,
  reachRoleParamsSchema,
  recordAccessParamsSchema,
  type OwnedObject,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { ExplainerService } from './explainer.service.js';

/**
 * `/api/v1/access` — the catalogue and the explainer (ADR-0007, ADR-0033).
 *
 * Every route is for administrators, and that is enforced by `can()` in the
 * service, not here: this controller has no idea who an administrator is.
 */
@Controller('access')
export class AccessController {
  constructor(@Inject(ExplainerService) private readonly explainer: ExplainerService) {}

  @Get('catalogue')
  async catalogue(@CurrentActor() actor: Actor) {
    return { data: await this.explainer.catalogue(actor) };
  }

  @Get('records/:objectType/:id')
  async record(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(recordAccessParamsSchema)) params: { objectType: OwnedObject; id: string },
  ) {
    return { data: await this.explainer.recordAccess(actor, params.objectType, params.id) };
  }

  @Get('members/:userId')
  async member(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(reachMemberParamsSchema)) params: { userId: string },
  ) {
    return { data: await this.explainer.memberReach(actor, params.userId) };
  }

  @Get('roles/:id')
  async role(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(reachRoleParamsSchema)) params: { id: string },
  ) {
    return { data: await this.explainer.roleReach(actor, params.id) };
  }
}
