import { Module } from '@nestjs/common';
import { LEAD_ASSIGNER } from '../../platform/lead-assigner.js';
import { AccessModule } from '../access/access.module.js';
import { AssignmentEvaluator, RulesLeadAssigner } from './assignment-evaluator.js';
import { LeadAssignmentController } from './lead-assignment.controller.js';
import { LeadAssignmentRepository } from './lead-assignment.repository.js';
import { LeadAssignmentService } from './lead-assignment.service.js';

/**
 * Lead assignment rules (ADR-0001, ADR-0065 10).
 *
 * Owns the three assignment tables and provides the assigner a website form asks "who gets this
 * lead". It reaches people only through the access module's narrow `LeadOwnerDirectory`, and the
 * form module reaches it only through the `LEAD_ASSIGNER` token; neither touches the other's tables.
 * Written so manual and imported leads can ask the same question later (the trigger is a parameter).
 */
@Module({
  imports: [AccessModule],
  controllers: [LeadAssignmentController],
  providers: [
    LeadAssignmentRepository,
    LeadAssignmentService,
    AssignmentEvaluator,
    RulesLeadAssigner,
    { provide: LEAD_ASSIGNER, useExisting: RulesLeadAssigner },
  ],
  exports: [LEAD_ASSIGNER],
})
export class LeadAssignmentModule {}
