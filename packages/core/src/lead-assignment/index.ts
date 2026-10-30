/**
 * Who gets a new lead: the assignment rules of a company (ADR-0065 10).
 *
 * Pure, like the other rule files (`pipelines`, `deals/stage-rules`): no database, no clock, no
 * randomness. The API loads what is needed, asks `evaluateAssignment`, and writes what it answers,
 * so every rule here is a unit test and "never throws" is a property that can be checked rather than
 * hoped for.
 *
 * Rules are an ordered list per company; the first one that matches **and can be carried out** wins.
 * There is deliberately no scripting and no regular expression (a pattern a company types, run on
 * text a stranger types, is a way to stall a server): a handful of fixed operators.
 */

/** Where a lead came from. Only the web form uses rules in v1; the others are designed for. */
export const ASSIGNMENT_TRIGGERS = ['web_form', 'manual', 'import'] as const;
export type AssignmentTrigger = (typeof ASSIGNMENT_TRIGGERS)[number];

export const MAX_ASSIGNMENT_RULES = 50;
export const MAX_RULE_CONDITIONS = 10;
export const RULE_NAME_MAX_LENGTH = 80;
export const CONDITION_VALUE_MAX_LENGTH = 200;
export const MAX_IN_VALUES = 20;

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'in',
  'contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** `is_empty` and `is_not_empty` take no value; `in` takes a list; the rest take one text. */
export interface RuleCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: string | readonly string[] | undefined;
}

export type RuleAction =
  | { readonly type: 'user'; readonly userId: string }
  | { readonly type: 'team_round_robin'; readonly teamId: string }
  | { readonly type: 'default_owner' };

export interface AssignmentRule {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly appliesTo: readonly AssignmentTrigger[];
  readonly conditions: readonly RuleCondition[];
  readonly action: RuleAction;
}

/** What a lead is judged by: its fields by key, plus `source` and `form_id`. */
export type LeadFacts = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function normal(text: string): string {
  return text.normalize('NFC').trim().toLowerCase();
}

/** The text a fact is compared as, or null if it has none (absent, empty, or not comparable). */
function factTexts(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const text = normal(value);
    return text === '' ? null : [text];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [normal(String(value))];
  if (Array.isArray(value)) {
    const texts = value
      .filter((entry): entry is string | number | boolean =>
        ['string', 'number', 'boolean'].includes(typeof entry),
      )
      .map((entry) => normal(String(entry)))
      .filter((text) => text !== '');
    return texts.length === 0 ? null : texts;
  }
  return null;
}

/** Does one condition hold for these facts? Total: it never throws, whatever the facts hold. */
export function conditionHolds(condition: RuleCondition, facts: LeadFacts): boolean {
  const have = factTexts(facts[condition.field]);

  switch (condition.operator) {
    case 'is_empty':
      return have === null;
    case 'is_not_empty':
      return have !== null;
    case 'equals': {
      if (typeof condition.value !== 'string') return false;
      const want = normal(condition.value);
      return have !== null && have.includes(want);
    }
    case 'not_equals': {
      if (typeof condition.value !== 'string') return false;
      const want = normal(condition.value);
      return have === null || !have.includes(want);
    }
    case 'in': {
      if (!Array.isArray(condition.value)) return false;
      const wanted = (condition.value as readonly string[]).map(normal);
      return have !== null && have.some((text) => wanted.includes(text));
    }
    case 'contains': {
      if (typeof condition.value !== 'string') return false;
      const want = normal(condition.value);
      return want !== '' && have !== null && have.some((text) => text.includes(want));
    }
    case 'starts_with': {
      if (typeof condition.value !== 'string') return false;
      const want = normal(condition.value);
      return want !== '' && have !== null && have.some((text) => text.startsWith(want));
    }
  }
}

/** A rule with no conditions matches every lead of its triggers: that is how a catch-all is written. */
export function ruleMatches(
  rule: AssignmentRule,
  facts: LeadFacts,
  trigger: AssignmentTrigger,
): boolean {
  if (!rule.enabled || !rule.appliesTo.includes(trigger)) return false;
  return rule.conditions.every((condition) => conditionHolds(condition, facts));
}

// ---------------------------------------------------------------------------
// Checking a rule before it is saved
// ---------------------------------------------------------------------------

export interface RuleIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The problems with a rule's shape, as sentences. `knownFields` is every field key a condition may
 * look at (the lead's own fields, `source` and `form_id`); who the action may name is the API's to
 * check (it needs the database).
 */
export function checkRuleShape(
  rule: {
    readonly name: string;
    readonly conditions: readonly RuleCondition[];
    readonly appliesTo: readonly string[];
  },
  knownFields: ReadonlySet<string>,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (rule.name.trim() === '' || rule.name.length > RULE_NAME_MAX_LENGTH) {
    issues.push({
      path: 'name',
      message: `A rule name is 1 to ${RULE_NAME_MAX_LENGTH} characters`,
    });
  }
  if (rule.conditions.length > MAX_RULE_CONDITIONS) {
    issues.push({
      path: 'conditions',
      message: `A rule has at most ${MAX_RULE_CONDITIONS} conditions`,
    });
  }
  if (rule.appliesTo.length === 0) {
    issues.push({ path: 'appliesTo', message: 'A rule applies to at least one kind of lead' });
  }

  rule.conditions.forEach((condition, index) => {
    const path = `conditions.${index}`;
    if (!knownFields.has(condition.field)) {
      issues.push({ path: `${path}.field`, message: 'That is not a field of a lead' });
    }
    if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') {
      if (condition.value !== undefined) {
        issues.push({ path: `${path}.value`, message: 'This test takes no value' });
      }
    } else if (condition.operator === 'in') {
      const list = condition.value;
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        list.length > MAX_IN_VALUES ||
        (list as readonly unknown[]).some(
          (entry) =>
            typeof entry !== 'string' ||
            entry.trim() === '' ||
            entry.length > CONDITION_VALUE_MAX_LENGTH,
        )
      ) {
        issues.push({
          path: `${path}.value`,
          message: `Give 1 to ${MAX_IN_VALUES} values to choose from`,
        });
      }
    } else if (
      typeof condition.value !== 'string' ||
      condition.value.trim() === '' ||
      condition.value.length > CONDITION_VALUE_MAX_LENGTH
    ) {
      issues.push({ path: `${path}.value`, message: 'Give a value to compare with' });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Choosing a person
// ---------------------------------------------------------------------------

/** What `evaluateAssignment` needs to know about people. All of it is loaded by the caller. */
export interface AssignmentContext {
  readonly trigger: AssignmentTrigger;
  /** People who may be given a lead: active, and whose role reads and updates leads. */
  readonly eligible: ReadonlySet<string>;
  /** The members of each team a rule may name. */
  readonly teamMembers: ReadonlyMap<string, readonly string[]>;
  /** The last person each round-robin rule gave a lead to, by rule id. */
  readonly pointers: ReadonlyMap<string, string | null>;
  /** Who gets a lead when nothing else decides, best first. The first eligible one is used. */
  readonly defaults: readonly string[];
}

export type AssignmentReason = 'rule' | 'default_owner' | 'fallback' | 'nobody_eligible';

export interface AssignmentDecision {
  readonly ownerId: string | null;
  readonly reason: AssignmentReason;
  readonly ruleId: string | null;
  /** Set when a round-robin rule chose: the pointer to write. */
  readonly pointerUpdate: { readonly ruleId: string; readonly userId: string } | null;
}

/** The next in turn after `last`, wrapping: members are taken in id order so the turn is stable. */
export function nextInTurn(members: readonly string[], last: string | null): string | null {
  const ordered = [...new Set(members)].sort();
  if (ordered.length === 0) return null;
  if (last === null) return ordered[0] ?? null;
  return ordered.find((member) => member > last) ?? ordered[0] ?? null;
}

function firstEligible(
  candidates: readonly string[],
  eligible: ReadonlySet<string>,
): string | null {
  return candidates.find((candidate) => eligible.has(candidate)) ?? null;
}

/**
 * Decide who gets a lead.
 *
 * Rules are tried in order of `position`. A rule that matches but cannot be carried out (its person
 * is no longer eligible, its team has nobody eligible) is **skipped**, not stopped at: the next rule
 * is tried, and finally the defaults. So a lead is never left unassigned because one rule went
 * stale, and a lead is left with nobody only when nobody at all can take it.
 *
 * Total and pure: it throws for no input, and the same input is the same answer.
 */
export function evaluateAssignment(
  rules: readonly AssignmentRule[],
  facts: LeadFacts,
  context: AssignmentContext,
): AssignmentDecision {
  const ordered = [...rules].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  for (const rule of ordered) {
    if (!ruleMatches(rule, facts, context.trigger)) continue;

    switch (rule.action.type) {
      case 'user': {
        if (context.eligible.has(rule.action.userId)) {
          return {
            ownerId: rule.action.userId,
            reason: 'rule',
            ruleId: rule.id,
            pointerUpdate: null,
          };
        }
        break;
      }
      case 'team_round_robin': {
        const members = (context.teamMembers.get(rule.action.teamId) ?? []).filter((member) =>
          context.eligible.has(member),
        );
        const chosen = nextInTurn(members, context.pointers.get(rule.id) ?? null);
        if (chosen !== null) {
          return {
            ownerId: chosen,
            reason: 'rule',
            ruleId: rule.id,
            pointerUpdate: { ruleId: rule.id, userId: chosen },
          };
        }
        break;
      }
      case 'default_owner': {
        const owner = firstEligible(context.defaults, context.eligible);
        if (owner !== null) {
          return { ownerId: owner, reason: 'default_owner', ruleId: rule.id, pointerUpdate: null };
        }
        break;
      }
    }
  }

  const owner = firstEligible(context.defaults, context.eligible);
  return owner === null
    ? { ownerId: null, reason: 'nobody_eligible', ruleId: null, pointerUpdate: null }
    : { ownerId: owner, reason: 'fallback', ruleId: null, pointerUpdate: null };
}
