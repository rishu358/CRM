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
  assignmentRuleCreateSchema,
  assignmentRuleDeleteQuerySchema,
  assignmentRuleOrderSchema,
  assignmentRuleParamsSchema,
  assignmentRuleUpdateSchema,
  assignmentSettingsUpdateSchema,
  assignmentTestSchema,
  type AssignmentRuleCreateInput,
  type AssignmentRuleDeleteQuery,
  type AssignmentRuleOrderInput,
  type AssignmentRuleParams,
  type AssignmentRuleUpdateInput,
  type AssignmentSettingsUpdateInput,
  type AssignmentTestInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { LeadAssignmentService } from './lead-assignment.service.js';

/**
 * `/api/v1/lead-assignment` (ADR-0007, ADR-0065 10): the rules that choose who gets a new lead.
 *
 * Validate, hand off, wrap in the envelope. Who may do what is decided in the service by `can()` on
 * the `lead_assignment` object; no route takes a workspace or a user.
 */
@Controller('lead-assignment')
export class LeadAssignmentController {
  constructor(@Inject(LeadAssignmentService) private readonly rules: LeadAssignmentService) {}

  @Get()
  async overview(@CurrentActor() actor: Actor) {
    return { data: await this.rules.overview(actor) };
  }

  @Post('rules')
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(assignmentRuleCreateSchema)) body: AssignmentRuleCreateInput,
  ) {
    return { data: await this.rules.create(actor, body) };
  }

  /** Declared before `rules/:id`, or `order` would be read as an id. */
  @Post('rules/order')
  @HttpCode(200)
  async order(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(assignmentRuleOrderSchema)) body: AssignmentRuleOrderInput,
  ) {
    return { data: await this.rules.order(actor, body) };
  }

  @Patch('rules/:id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(assignmentRuleParamsSchema)) params: AssignmentRuleParams,
    @Body(zodPipe(assignmentRuleUpdateSchema)) body: AssignmentRuleUpdateInput,
  ) {
    return { data: await this.rules.update(actor, params.id, body) };
  }

  @Delete('rules/:id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(assignmentRuleParamsSchema)) params: AssignmentRuleParams,
    @Query(zodPipe(assignmentRuleDeleteQuerySchema)) query: AssignmentRuleDeleteQuery,
  ): Promise<void> {
    await this.rules.remove(actor, params.id, query.version);
  }

  @Patch('settings')
  async settings(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(assignmentSettingsUpdateSchema)) body: AssignmentSettingsUpdateInput,
  ) {
    return { data: await this.rules.updateSettings(actor, body) };
  }

  @Post('test')
  @HttpCode(200)
  async test(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(assignmentTestSchema)) body: AssignmentTestInput,
  ) {
    return { data: await this.rules.test(actor, body) };
  }
}
