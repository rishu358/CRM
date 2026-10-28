import {
  ASSIGNMENT_TRIGGERS,
  CONDITION_OPERATORS,
  CONDITION_VALUE_MAX_LENGTH,
  MAX_ASSIGNMENT_RULES,
  MAX_IN_VALUES,
  MAX_RULE_CONDITIONS,
  RULE_NAME_MAX_LENGTH,
} from '@crm/core';
import { z } from 'zod';

/**
 * Lead assignment rules (ADR-0065 10): who gets a new lead.
 *
 * Every write returns what the screen needs to redraw. Request bodies are `.strict()`. What a rule
 * may name (a person who can work leads, a team that exists) is checked by the API, which has the
 * database; the shape of a rule is also checked by `checkRuleShape` in `@crm/core`.
 */

export {
  ASSIGNMENT_TRIGGERS,
  CONDITION_OPERATORS,
  MAX_ASSIGNMENT_RULES,
  MAX_IN_VALUES,
  MAX_RULE_CONDITIONS,
  RULE_NAME_MAX_LENGTH,
};

export const assignmentTriggerSchema = z.enum(ASSIGNMENT_TRIGGERS);
export const conditionOperatorSchema = z.enum(CONDITION_OPERATORS);

export const ruleConditionSchema = z
  .object({
    field: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    operator: conditionOperatorSchema,
    value: z
      .union([
        z.string().max(CONDITION_VALUE_MAX_LENGTH),
        z.array(z.string().max(CONDITION_VALUE_MAX_LENGTH)).max(MAX_IN_VALUES),
      ])
      .optional(),
  })
  .strict();
export type RuleConditionInput = z.infer<typeof ruleConditionSchema>;

export const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.uuid() }).strict(),
  z.object({ type: z.literal('team_round_robin'), teamId: z.uuid() }).strict(),
  z.object({ type: z.literal('default_owner') }).strict(),
]);
export type RuleActionInput = z.infer<typeof ruleActionSchema>;

const nameSchema = z.string().trim().min(1).max(RULE_NAME_MAX_LENGTH);

export const assignmentRuleCreateSchema = z
  .object({
    name: nameSchema,
    enabled: z.boolean().default(true),
    appliesTo: z.array(assignmentTriggerSchema).min(1).max(3).default(['web_form']),
    conditions: z.array(ruleConditionSchema).max(MAX_RULE_CONDITIONS).default([]),
    action: ruleActionSchema,
  })
  .strict();
export type AssignmentRuleCreateInput = z.infer<typeof assignmentRuleCreateSchema>;

export const assignmentRuleUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    appliesTo: z.array(assignmentTriggerSchema).min(1).max(3).optional(),
    conditions: z.array(ruleConditionSchema).max(MAX_RULE_CONDITIONS).optional(),
    action: ruleActionSchema.optional(),
    version: z.coerce.number().int().positive(),
  })
  .strict();
export type AssignmentRuleUpdateInput = z.infer<typeof assignmentRuleUpdateSchema>;

export const assignmentRuleParamsSchema = z.object({ id: z.uuid() }).strict();
export type AssignmentRuleParams = z.infer<typeof assignmentRuleParamsSchema>;

export const assignmentRuleDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export type AssignmentRuleDeleteQuery = z.infer<typeof assignmentRuleDeleteQuerySchema>;

/** The whole order, every rule once: a partial order would leave a rule's place to chance. */
export const assignmentRuleOrderSchema = z
  .object({ ruleIds: z.array(z.uuid()).min(1).max(MAX_ASSIGNMENT_RULES) })
  .strict();
export type AssignmentRuleOrderInput = z.infer<typeof assignmentRuleOrderSchema>;

export const assignmentSettingsUpdateSchema = z
  .object({ defaultOwnerId: z.uuid().nullable(), version: z.coerce.number().int().positive() })
  .strict();
export type AssignmentSettingsUpdateInput = z.infer<typeof assignmentSettingsUpdateSchema>;

export const assignmentRuleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  enabled: z.boolean(),
  appliesTo: z.array(assignmentTriggerSchema),
  conditions: z.array(ruleConditionSchema),
  action: ruleActionSchema,
  version: z.number().int(),
});
export type AssignmentRule = z.infer<typeof assignmentRuleSchema>;

export const assignmentOverviewSchema = z.object({
  rules: z.array(assignmentRuleSchema),
  settings: z.object({
    defaultOwnerId: z.uuid().nullable(),
    /** Whether the default owner can still work leads. A person who left makes this false. */
    defaultOwnerEligible: z.boolean(),
    version: z.number().int(),
  }),
  /** The lead fields a condition may look at, in field order, plus `source` and `form_id`. */
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    }),
  ),
  /** People who can be given a lead, for the pickers. */
  people: z.array(z.object({ id: z.uuid(), name: z.string() })),
  teams: z.array(z.object({ id: z.uuid(), name: z.string(), eligibleMembers: z.number().int() })),
  maxRules: z.number().int(),
});
export type AssignmentOverview = z.infer<typeof assignmentOverviewSchema>;

export const assignmentTestSchema = z
  .object({
    trigger: assignmentTriggerSchema.default('web_form'),
    /** A sample lead: its fields by key. Nothing is saved, and no turn is taken. */
    fields: z
      .record(
        z.string().max(63),
        z.union([
          z.string().max(500),
          z.number(),
          z.boolean(),
          z.array(z.string().max(200)).max(30),
        ]),
      )
      .default({}),
  })
  .strict();
export type AssignmentTestInput = z.infer<typeof assignmentTestSchema>;

export const assignmentTestResultSchema = z.object({
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  reason: z.enum(['rule', 'default_owner', 'fallback', 'nobody_eligible']),
  ruleId: z.uuid().nullable(),
  ruleName: z.string().nullable(),
});
export type AssignmentTestResult = z.infer<typeof assignmentTestResultSchema>;
