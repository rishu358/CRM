import { Inject, Injectable } from '@nestjs/common';
import {
  ASSIGNMENT_TRIGGERS,
  evaluateAssignment,
  type AssignmentContext,
  type AssignmentRule,
  type AssignmentTrigger,
  type RuleAction,
  type RuleCondition,
} from '@crm/core';
import type { Tx } from '@crm/db';
import type { LeadAssigner, LeadAssignmentDecision } from '../../platform/lead-assigner.js';
import { LeadOwnerDirectory } from '../access/lead-owner-directory.service.js';
import { LeadAssignmentRepository, type RuleRow } from './lead-assignment.repository.js';

/** A stored rule as the pure function reads it. What is stored was checked when it was written. */
export function toCoreRule(row: RuleRow): AssignmentRule {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    appliesTo: row.appliesTo.filter((entry): entry is AssignmentTrigger =>
      (ASSIGNMENT_TRIGGERS as readonly string[]).includes(entry),
    ),
    conditions: row.conditions as unknown as readonly RuleCondition[],
    action: row.action as unknown as RuleAction,
  };
}

export interface EvaluationRequest {
  readonly tenantId: string;
  readonly trigger: AssignmentTrigger;
  readonly facts: Readonly<Record<string, unknown>>;
  /** The form's maker, offered as a default after the company's own default owner. */
  readonly formCreatedBy: string | null;
}

/**
 * Loads what the rules need to know and asks the pure function (ADR-0065 10).
 *
 * `takeTurn` is the difference between a real lead and a test: a real one locks the round-robin
 * pointer of the rule that chose, re-decides with the locked value (another submission may have
 * moved it a moment ago), and writes the new pointer; a test only reads, so trying a sample lead
 * never changes who gets the next real one.
 */
@Injectable()
export class AssignmentEvaluator {
  constructor(
    @Inject(LeadAssignmentRepository) private readonly repository: LeadAssignmentRepository,
    @Inject(LeadOwnerDirectory) private readonly owners: LeadOwnerDirectory,
  ) {}

  async decide(
    tx: Tx,
    request: EvaluationRequest,
    options: { readonly takeTurn: boolean },
  ): Promise<LeadAssignmentDecision> {
    const rows = await this.repository.listRules(tx, request.tenantId);
    const rules = rows.map(toCoreRule);
    const settings = await this.repository.findSettings(tx, request.tenantId);
    const manager = await this.owners.longestStandingFormManager(tx, request.tenantId);

    const defaults = [settings?.defaultOwnerId ?? null, request.formCreatedBy, manager].filter(
      (id): id is string => id !== null,
    );
    const teamIds = rules.flatMap((rule) =>
      rule.action.type === 'team_round_robin' ? [rule.action.teamId] : [],
    );
    const teamMembers = await this.owners.teamMembers(tx, request.tenantId, teamIds);
    const named = rules.flatMap((rule) =>
      rule.action.type === 'user' ? [rule.action.userId] : [],
    );
    const everyone = [...defaults, ...named, ...[...teamMembers.values()].flat()];
    const eligible = await this.owners.eligible(tx, request.tenantId, everyone);

    const context = (pointers: ReadonlyMap<string, string | null>): AssignmentContext => ({
      trigger: request.trigger,
      eligible,
      teamMembers,
      pointers,
      defaults,
    });

    let decision = evaluateAssignment(
      rules,
      request.facts,
      context(await this.repository.readPointers(tx, request.tenantId)),
    );

    if (options.takeTurn && decision.pointerUpdate !== null) {
      const ruleId = decision.pointerUpdate.ruleId;
      const locked = await this.repository.lockPointer(tx, request.tenantId, ruleId);
      decision = evaluateAssignment(rules, request.facts, context(new Map([[ruleId, locked]])));
      if (decision.pointerUpdate !== null) {
        await this.repository.setPointer(
          tx,
          request.tenantId,
          decision.pointerUpdate.ruleId,
          decision.pointerUpdate.userId,
        );
      }
    }

    return {
      ownerId: decision.ownerId,
      reason: decision.reason,
      ruleId: decision.ruleId,
      ruleName: rules.find((rule) => rule.id === decision.ruleId)?.name ?? null,
    };
  }
}

/** The assigner a submission uses: the rules, taking a turn. */
@Injectable()
export class RulesLeadAssigner implements LeadAssigner {
  constructor(@Inject(AssignmentEvaluator) private readonly evaluator: AssignmentEvaluator) {}

  pickOwner(
    tx: Tx,
    request: Parameters<LeadAssigner['pickOwner']>[1],
  ): Promise<LeadAssignmentDecision> {
    return this.evaluator.decide(
      tx,
      {
        tenantId: request.tenantId,
        trigger: request.trigger,
        facts: request.facts,
        formCreatedBy: request.formCreatedBy,
      },
      { takeTurn: true },
    );
  }
}
