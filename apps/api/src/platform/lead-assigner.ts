import type { AssignmentReason, AssignmentTrigger } from '@crm/core';
import type { Tx } from '@crm/db';

/**
 * Who gets a new lead (ADR-0065 10): the one question the website form asks and does not answer.
 *
 * It lives in the platform folder, not in either module, so the module that makes leads from forms
 * and the module that owns the assignment rules can depend on it without depending on each other.
 *
 * An implementation must not throw and must not block: the caller runs it inside a savepoint and
 * treats any failure as "ask the fallback", so a broken rule can never cost a lead.
 */
export interface LeadAssignmentRequest {
  readonly tenantId: string;
  readonly trigger: AssignmentTrigger;
  readonly formId: string;
  readonly formCreatedBy: string | null;
  /** The new lead's values by field key, plus `source` and `form_id`. */
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface LeadAssignmentDecision {
  readonly ownerId: string | null;
  readonly reason: AssignmentReason;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
}

export interface LeadAssigner {
  pickOwner(tx: Tx, request: LeadAssignmentRequest): Promise<LeadAssignmentDecision>;
}

/** The assigner a submission uses. */
export const LEAD_ASSIGNER = 'LEAD_ASSIGNER';
/** Who is asked when `LEAD_ASSIGNER` fails: the simplest honest answer. */
export const LEAD_FALLBACK_ASSIGNER = 'LEAD_FALLBACK_ASSIGNER';
