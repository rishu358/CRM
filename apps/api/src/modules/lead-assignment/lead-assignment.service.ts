import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  MAX_ASSIGNMENT_RULES,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  assertCan,
  checkRuleShape,
  newId,
  type Actor,
  type AssignmentTrigger,
  type ErrorDetail,
  type RuleAction,
  type RuleCondition,
} from '@crm/core';
import type {
  AssignmentOverview,
  AssignmentRule,
  AssignmentRuleCreateInput,
  AssignmentRuleOrderInput,
  AssignmentRuleUpdateInput,
  AssignmentSettingsUpdateInput,
  AssignmentTestInput,
  AssignmentTestResult,
} from '@crm/contracts';
import type { Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { LeadOwnerDirectory } from '../access/lead-owner-directory.service.js';
import { AssignmentEvaluator, toCoreRule } from './assignment-evaluator.js';
import { LeadAssignmentRepository, type RuleRow } from './lead-assignment.repository.js';

/** The fields a condition may look at that are not lead fields: the origin of the lead. */
const SYNTHETIC_FIELDS = [{ key: 'form_id', label: 'Web form', type: 'text' }] as const;

function serializeRule(row: RuleRow): AssignmentRule {
  const rule = toCoreRule(row);
  return {
    id: rule.id,
    name: rule.name,
    position: rule.position,
    enabled: rule.enabled,
    appliesTo: [...rule.appliesTo],
    conditions: rule.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      ...(condition.value === undefined
        ? {}
        : { value: Array.isArray(condition.value) ? [...condition.value] : condition.value }),
    })) as AssignmentRule['conditions'],
    action: rule.action as AssignmentRule['action'],
    version: row.version,
  };
}

/** What an audit entry says about a rule: its name, its place and what it does, in words. */
function auditView(row: RuleRow): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    appliesTo: row.appliesTo.join(','),
    conditions: JSON.stringify(row.conditions),
    action: JSON.stringify(row.action),
  };
}

/**
 * The assignment rules: the administration side (ADR-0065 10).
 *
 * The same steps every module follows: `can()` on the `lead_assignment` object before anything else,
 * the rules of the rule (its shape, and that the person or team it names exists and can work leads),
 * the write with the audit entry and the event in ONE transaction, and an answer that redraws the
 * screen from one response. Changes to one company's rules are serialised by a lock on its settings
 * row, so two administrators cannot interleave a reorder with an edit.
 *
 * A rule that is not in the caller's company is a 404, exactly like one that does not exist.
 */
@Injectable()
export class LeadAssignmentService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LeadAssignmentRepository) private readonly repository: LeadAssignmentRepository,
    @Inject(LeadOwnerDirectory) private readonly owners: LeadOwnerDirectory,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AssignmentEvaluator) private readonly evaluator: AssignmentEvaluator,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async overview(actor: Actor): Promise<AssignmentOverview> {
    assertCan(actor, 'read', { objectType: 'lead_assignment' });
    return this.inTenant(actor, (tx) => this.overviewInTx(actor, tx));
  }

  async create(actor: Actor, input: AssignmentRuleCreateInput): Promise<AssignmentOverview> {
    assertCan(actor, 'create', { objectType: 'lead_assignment' });

    return this.inTenant(actor, async (tx) => {
      await this.repository.lockSettings(tx, actor.tenantId);
      await this.checkRule(tx, actor, input);

      let row: RuleRow;
      try {
        row = await this.repository.insertRule(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          name: input.name,
          position: await this.repository.nextPosition(tx, actor.tenantId),
          enabled: input.enabled,
          appliesTo: input.appliesTo,
          conditions: input.conditions,
          action: input.action,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } catch (error) {
        if (isConstraintViolation(error, 'lead_assignment_rules_name_key')) throw nameTaken();
        if (isConstraintViolation(error, 'lead_assignment_rules_cap')) throw tooMany();
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'lead_assignment',
        recordId: row.id,
        changes: diffChanges({}, auditView(row)),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_assignment_rule.created.v1',
        objectType: 'lead_assignment',
        recordId: row.id,
      });
      return this.overviewInTx(actor, tx);
    });
  }

  async update(
    actor: Actor,
    id: string,
    input: AssignmentRuleUpdateInput,
  ): Promise<AssignmentRule> {
    assertCan(actor, 'update', { objectType: 'lead_assignment' });

    return this.inTenant(actor, async (tx) => {
      await this.repository.lockSettings(tx, actor.tenantId);
      const existing = await this.repository.lockRule(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Rule');
      if (existing.version !== input.version) throw new VersionConflictError('rule');

      const patch: Partial<RuleRow> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.appliesTo !== undefined) patch.appliesTo = input.appliesTo;
      if (input.conditions !== undefined) patch.conditions = input.conditions;
      if (input.action !== undefined) patch.action = input.action;

      // Only what changed is judged: switching a rule off must never be refused because the person it
      // names has since left.
      if (
        input.name !== undefined ||
        input.appliesTo !== undefined ||
        input.conditions !== undefined ||
        input.action !== undefined
      ) {
        await this.checkRule(
          tx,
          actor,
          {
            name: input.name ?? existing.name,
            appliesTo: (input.appliesTo ?? existing.appliesTo) as AssignmentTrigger[],
            conditions: (input.conditions ??
              (existing.conditions as unknown as RuleCondition[])) as RuleCondition[],
            action: (input.action ?? (existing.action as unknown as RuleAction)) as RuleAction,
          },
          { checkAction: input.action !== undefined },
        );
      }

      let row: RuleRow;
      try {
        row = await this.repository.updateRule(tx, actor.tenantId, id, patch, actor.userId);
      } catch (error) {
        if (isConstraintViolation(error, 'lead_assignment_rules_name_key')) throw nameTaken();
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_assignment',
        recordId: id,
        changes: diffChanges(auditView(existing), auditView(row)),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_assignment_rule.updated.v1',
        objectType: 'lead_assignment',
        recordId: id,
      });
      return serializeRule(row);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'lead_assignment' });

    await this.inTenant(actor, async (tx) => {
      await this.repository.lockSettings(tx, actor.tenantId);
      const existing = await this.repository.lockRule(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Rule');
      if (existing.version !== version) throw new VersionConflictError('rule');

      await this.repository.deleteRule(tx, actor.tenantId, id);
      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'lead_assignment',
        recordId: id,
        changes: diffChanges(auditView(existing), {}),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_assignment_rule.deleted.v1',
        objectType: 'lead_assignment',
        recordId: id,
      });
    });
  }

  async order(actor: Actor, input: AssignmentRuleOrderInput): Promise<AssignmentOverview> {
    assertCan(actor, 'update', { objectType: 'lead_assignment' });

    return this.inTenant(actor, async (tx) => {
      await this.repository.lockSettings(tx, actor.tenantId);
      const rules = await this.repository.listRules(tx, actor.tenantId);
      const have = new Set(rules.map((rule) => rule.id));
      const given = new Set(input.ruleIds);
      if (
        given.size !== input.ruleIds.length ||
        given.size !== have.size ||
        [...given].some((id) => !have.has(id))
      ) {
        throw new ConflictError('The order must name every rule exactly once', [
          { path: 'ruleIds', message: 'Reload the rules and try again' },
        ]);
      }

      await this.repository.writeOrder(tx, actor.tenantId, input.ruleIds);
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_assignment',
        recordId: null,
        changes: {
          order: {
            old: rules.map((rule) => rule.name).join(' > '),
            new: input.ruleIds
              .map((id) => rules.find((rule) => rule.id === id)?.name ?? '')
              .join(' > '),
          },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_assignment_rules.ordered.v1',
        objectType: 'lead_assignment',
        recordId: actor.tenantId,
      });
      return this.overviewInTx(actor, tx);
    });
  }

  async updateSettings(
    actor: Actor,
    input: AssignmentSettingsUpdateInput,
  ): Promise<AssignmentOverview> {
    assertCan(actor, 'update', { objectType: 'lead_assignment' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.lockSettings(tx, actor.tenantId);
      if (existing.version !== input.version) throw new VersionConflictError('setting');

      if (input.defaultOwnerId !== null) {
        const eligible = await this.owners.eligible(tx, actor.tenantId, [input.defaultOwnerId]);
        if (!eligible.has(input.defaultOwnerId)) {
          throw new ValidationError([
            { path: 'defaultOwnerId', message: 'That person cannot be given leads' },
          ]);
        }
      }
      await this.repository.setDefaultOwner(tx, actor.tenantId, input.defaultOwnerId, actor.userId);
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_assignment',
        recordId: null,
        changes: {
          defaultOwnerId: { old: existing.defaultOwnerId, new: input.defaultOwnerId },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_assignment.default_owner_changed.v1',
        objectType: 'lead_assignment',
        recordId: actor.tenantId,
      });
      return this.overviewInTx(actor, tx);
    });
  }

  /**
   * Who would get a lead like this one. Reads only: no turn is taken and nothing is written, so
   * trying rules out never changes who gets the next real lead.
   */
  async test(actor: Actor, input: AssignmentTestInput): Promise<AssignmentTestResult> {
    assertCan(actor, 'read', { objectType: 'lead_assignment' });

    return this.inTenant(actor, async (tx) => {
      const decision = await this.evaluator.decide(
        tx,
        {
          tenantId: actor.tenantId,
          trigger: input.trigger,
          facts: { ...input.fields, source: input.fields['source'] ?? 'web_form' },
          formCreatedBy: null,
        },
        { takeTurn: false },
      );
      const people = new Map(
        (await this.owners.workers(tx, actor.tenantId)).map((person) => [person.id, person.name]),
      );
      return {
        ownerId: decision.ownerId,
        ownerName: decision.ownerId === null ? null : (people.get(decision.ownerId) ?? null),
        reason: decision.reason,
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async overviewInTx(actor: Actor, tx: Tx): Promise<AssignmentOverview> {
    const [rules, settings, definitions, people, teams] = await Promise.all([
      this.repository.listRules(tx, actor.tenantId),
      this.repository.findSettings(tx, actor.tenantId),
      this.fieldMetadata.forObject(tx, actor.tenantId, 'lead'),
      this.owners.workers(tx, actor.tenantId),
      this.owners.teams(tx, actor.tenantId),
    ]);
    const members = await this.owners.teamMembers(
      tx,
      actor.tenantId,
      teams.map((team) => team.id),
    );
    const working = new Set(people.map((person) => person.id));
    const defaultOwnerId = settings?.defaultOwnerId ?? null;

    return {
      rules: rules.map(serializeRule),
      settings: {
        defaultOwnerId,
        defaultOwnerEligible: defaultOwnerId !== null && working.has(defaultOwnerId),
        version: settings?.version ?? 1,
      },
      fields: [
        ...definitions
          .filter((definition) => definition.isActive)
          .map((definition) => ({
            key: definition.key,
            label: definition.label,
            type: definition.type,
            ...(definition.options === undefined
              ? {}
              : {
                  options: definition.options
                    .filter((option) => option.isActive !== false)
                    .map((option) => ({ value: option.value, label: option.label })),
                }),
          })),
        ...SYNTHETIC_FIELDS,
      ],
      people,
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        eligibleMembers: (members.get(team.id) ?? []).filter((id) => working.has(id)).length,
      })),
      maxRules: MAX_ASSIGNMENT_RULES,
    };
  }

  /** The rules of a rule, as one 422. `checkAction` is off when an edit leaves the target alone. */
  private async checkRule(
    tx: Tx,
    actor: Actor,
    rule: {
      readonly name: string;
      readonly appliesTo: readonly string[];
      readonly conditions: readonly RuleCondition[];
      readonly action: RuleAction;
    },
    options: { readonly checkAction: boolean } = { checkAction: true },
  ): Promise<void> {
    const definitions = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
    const known = new Set([
      ...definitions
        .filter((definition) => definition.isActive)
        .map((definition) => definition.key),
      ...SYNTHETIC_FIELDS.map((field) => field.key),
    ]);
    const issues: ErrorDetail[] = [...checkRuleShape(rule, known)];

    if (options.checkAction) {
      if (rule.action.type === 'user') {
        const eligible = await this.owners.eligible(tx, actor.tenantId, [rule.action.userId]);
        if (!eligible.has(rule.action.userId)) {
          issues.push({ path: 'action.userId', message: 'That person cannot be given leads' });
        }
      } else if (rule.action.type === 'team_round_robin') {
        const members = await this.owners.teamMembers(tx, actor.tenantId, [rule.action.teamId]);
        const team = members.get(rule.action.teamId);
        if (team === undefined) {
          issues.push({ path: 'action.teamId', message: 'That team does not exist' });
        } else if ((await this.owners.eligible(tx, actor.tenantId, team)).size === 0) {
          issues.push({
            path: 'action.teamId',
            message: 'Nobody in that team can be given leads',
          });
        }
      }
    }

    if (issues.length > 0) throw new ValidationError(issues);
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function nameTaken(): ConflictError {
  return new ConflictError('A rule with that name already exists', [
    { path: 'name', message: 'A rule with that name already exists' },
  ]);
}

function tooMany(): ConflictError {
  return new ConflictError(`A company can have at most ${MAX_ASSIGNMENT_RULES} assignment rules`);
}
