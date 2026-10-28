import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@crm/db';
import { LeadOwnerDirectory } from '../access/lead-owner-directory.service.js';
import type {
  LeadAssigner,
  LeadAssignmentDecision,
  LeadAssignmentRequest,
} from '../../platform/lead-assigner.js';

/**
 * The simplest honest answer to "who gets this lead" (ADR-0065 10), and the fallback when the rules
 * cannot answer: the form's creator if they can still read and update leads, else the
 * longest-standing active member whose role can update web forms and work leads, else nobody.
 * A person is recognised by what their role may do, never by what it is called.
 */
@Injectable()
export class DefaultOwnerAssigner implements LeadAssigner {
  constructor(@Inject(LeadOwnerDirectory) private readonly owners: LeadOwnerDirectory) {}

  async pickOwner(tx: Tx, request: LeadAssignmentRequest): Promise<LeadAssignmentDecision> {
    if (
      request.formCreatedBy !== null &&
      (await this.owners.isEligible(tx, request.tenantId, request.formCreatedBy))
    ) {
      return { ownerId: request.formCreatedBy, reason: 'fallback', ruleId: null, ruleName: null };
    }
    const manager = await this.owners.longestStandingFormManager(tx, request.tenantId);
    return manager === null
      ? { ownerId: null, reason: 'nobody_eligible', ruleId: null, ruleName: null }
      : { ownerId: manager, reason: 'fallback', ruleId: null, ruleName: null };
  }
}
