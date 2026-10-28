import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@crm/db';
import { LeadOwnerDirectory } from '../access/lead-owner-directory.service.js';

/**
 * Who gets a lead a website form has made (ADR-0063 10).
 *
 * The public module asks this and nothing else: it never knows how the answer is reached. In this
 * change the answer is the simplest honest one (the form's creator, if they can still work leads,
 * else the longest-standing person who manages forms, else nobody). The assignment rules replace the
 * provider behind `LEAD_ASSIGNER` without the public module changing.
 *
 * It must not throw and must not block a submission: the caller runs it inside a savepoint and
 * treats any failure as "assign to the fallback", so a broken rule can never cost a lead.
 */
export interface LeadAssignmentRequest {
  readonly tenantId: string;
  readonly formId: string;
  readonly formCreatedBy: string | null;
  /** The new lead's values by field key, for rules that look at them. */
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface LeadAssigner {
  pickOwner(tx: Tx, request: LeadAssignmentRequest): Promise<string | null>;
}

export const LEAD_ASSIGNER = 'LEAD_ASSIGNER';

@Injectable()
export class DefaultOwnerAssigner implements LeadAssigner {
  constructor(@Inject(LeadOwnerDirectory) private readonly owners: LeadOwnerDirectory) {}

  async pickOwner(tx: Tx, request: LeadAssignmentRequest): Promise<string | null> {
    if (
      request.formCreatedBy !== null &&
      (await this.owners.isEligible(tx, request.tenantId, request.formCreatedBy))
    ) {
      return request.formCreatedBy;
    }
    return this.owners.longestStandingFormManager(tx, request.tenantId);
  }
}
