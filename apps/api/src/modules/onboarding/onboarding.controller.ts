import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { tenantProfileUpdateSchema, type TenantProfileUpdateInput } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * `/api/v1/tenant` and `/api/v1/onboarding` (ADR-0007, ADR-0037).
 *
 * Validate with Zod, call the service, wrap in the envelope — the same shape as
 * every other controller. Authorization lives in the service, so this class has
 * no idea who an administrator is, and no route here takes a company id: the
 * company is the caller's own, read from the session.
 */
@Controller()
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Get('tenant')
  async profile(@CurrentActor() actor: Actor) {
    return { data: await this.onboarding.profile(actor) };
  }

  @Patch('tenant')
  async updateProfile(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(tenantProfileUpdateSchema)) body: TenantProfileUpdateInput,
  ) {
    return { data: await this.onboarding.updateProfile(actor, body) };
  }

  @Get('onboarding')
  async status(@CurrentActor() actor: Actor) {
    return { data: await this.onboarding.status(actor) };
  }

  @Post('onboarding/complete')
  @HttpCode(200)
  async complete(@CurrentActor() actor: Actor) {
    return { data: await this.onboarding.complete(actor) };
  }

  @Post('onboarding/sample-data')
  async loadSampleData(@CurrentActor() actor: Actor) {
    return { data: await this.onboarding.loadSampleData(actor) };
  }

  /** Accepted, not done: the cleanup runs in the worker. */
  @Delete('onboarding/sample-data')
  @HttpCode(202)
  async removeSampleData(@CurrentActor() actor: Actor) {
    return { data: await this.onboarding.requestSampleDataRemoval(actor) };
  }
}
