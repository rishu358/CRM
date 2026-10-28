import { describe, expect, it } from 'vitest';
import {
  checkRuleShape,
  conditionHolds,
  evaluateAssignment,
  nextInTurn,
  ruleMatches,
  type AssignmentContext,
  type AssignmentRule,
  type RuleCondition,
} from './index.js';

const ALICE = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const CARA = '00000000-0000-7000-8000-00000000000c';
const DEV = '00000000-0000-7000-8000-00000000000d';
const TEAM = '00000000-0000-7000-8000-0000000000aa';

function rule(id: string, position: number, extra: Partial<AssignmentRule> = {}): AssignmentRule {
  return {
    id,
    name: id,
    position,
    enabled: true,
    appliesTo: ['web_form'],
    conditions: [],
    action: { type: 'default_owner' },
    ...extra,
  };
}

function context(extra: Partial<AssignmentContext> = {}): AssignmentContext {
  return {
    trigger: 'web_form',
    eligible: new Set([ALICE, BOB, CARA]),
    teamMembers: new Map([[TEAM, [CARA, ALICE, BOB]]]),
    pointers: new Map(),
    defaults: [DEV, ALICE],
    ...extra,
  };
}

const eq = (field: string, value: string): RuleCondition => ({ field, operator: 'equals', value });

describe('conditions', () => {
  it('compares text ignoring case, spacing and accents form', () => {
    expect(conditionHolds(eq('city', 'Kolkata'), { city: '  KOLKATA ' })).toBe(true);
    expect(conditionHolds(eq('city', 'Kolkata'), { city: 'Mumbai' })).toBe(false);
    expect(conditionHolds(eq('name', 'café'), { name: 'café' })).toBe(true);
  });

  it('treats a missing or empty fact as empty, and not equal to anything', () => {
    for (const facts of [{}, { city: '' }, { city: '   ' }, { city: null }, { city: [] }]) {
      expect(conditionHolds({ field: 'city', operator: 'is_empty' }, facts)).toBe(true);
      expect(conditionHolds({ field: 'city', operator: 'is_not_empty' }, facts)).toBe(false);
      expect(conditionHolds(eq('city', 'x'), facts)).toBe(false);
      expect(conditionHolds({ field: 'city', operator: 'not_equals', value: 'x' }, facts)).toBe(
        true,
      );
    }
  });

  it('equals, in and contains look inside a list of choices', () => {
    const facts = { interest: ['Gold', 'Silver'] };
    expect(conditionHolds(eq('interest', 'silver'), facts)).toBe(true);
    expect(
      conditionHolds({ field: 'interest', operator: 'in', value: ['pearl', 'GOLD'] }, facts),
    ).toBe(true);
    expect(conditionHolds({ field: 'interest', operator: 'contains', value: 'ilv' }, facts)).toBe(
      true,
    );
    expect(
      conditionHolds({ field: 'interest', operator: 'not_equals', value: 'gold' }, facts),
    ).toBe(false);
  });

  it('numbers and booleans are compared as text', () => {
    expect(conditionHolds(eq('budget', '5000'), { budget: 5000 })).toBe(true);
    expect(conditionHolds(eq('wants_call', 'true'), { wants_call: true })).toBe(true);
  });

  it('contains and starts_with never match an empty needle', () => {
    expect(conditionHolds({ field: 'a', operator: 'contains', value: '' }, { a: 'x' })).toBe(false);
    expect(conditionHolds({ field: 'a', operator: 'starts_with', value: ' ' }, { a: 'x' })).toBe(
      false,
    );
    expect(conditionHolds({ field: 'a', operator: 'starts_with', value: 'ab' }, { a: 'Abc' })).toBe(
      true,
    );
  });

  it('is total: a malformed condition or odd fact is simply false, never an error', () => {
    const odd: unknown[] = [
      {},
      [],
      () => 1,
      Symbol('x'),
      {
        toString: () => {
          throw new Error('no');
        },
      },
    ];
    for (const value of odd) {
      expect(() => conditionHolds(eq('a', 'x'), { a: value })).not.toThrow();
      expect(conditionHolds(eq('a', 'x'), { a: value })).toBe(false);
    }
    expect(conditionHolds({ field: 'a', operator: 'equals' }, { a: 'x' })).toBe(false);
    expect(conditionHolds({ field: 'a', operator: 'in', value: 'x' }, { a: 'x' })).toBe(false);
    expect(conditionHolds({ field: 'a', operator: 'equals', value: ['x'] }, { a: 'x' })).toBe(
      false,
    );
  });

  it('has no pattern language: regular-expression text is only text', () => {
    expect(
      conditionHolds(eq('a', '(a+)+$'), { a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }),
    ).toBe(false);
    expect(conditionHolds({ field: 'a', operator: 'contains', value: '.*' }, { a: 'abc' })).toBe(
      false,
    );
  });
});

describe('which rules apply', () => {
  it('skips a rule that is off, or for another kind of lead, and matches an empty rule always', () => {
    expect(ruleMatches(rule('r', 1, { enabled: false }), {}, 'web_form')).toBe(false);
    expect(ruleMatches(rule('r', 1, { appliesTo: ['import'] }), {}, 'web_form')).toBe(false);
    expect(ruleMatches(rule('r', 1), {}, 'web_form')).toBe(true);
  });

  it('needs every condition', () => {
    const both = rule('r', 1, { conditions: [eq('city', 'pune'), eq('source', 'web_form')] });
    expect(ruleMatches(both, { city: 'Pune', source: 'web_form' }, 'web_form')).toBe(true);
    expect(ruleMatches(both, { city: 'Pune', source: 'x' }, 'web_form')).toBe(false);
  });
});

describe('round robin', () => {
  it('goes round in id order and wraps', () => {
    expect(nextInTurn([CARA, ALICE, BOB], null)).toBe(ALICE);
    expect(nextInTurn([CARA, ALICE, BOB], ALICE)).toBe(BOB);
    expect(nextInTurn([CARA, ALICE, BOB], BOB)).toBe(CARA);
    expect(nextInTurn([CARA, ALICE, BOB], CARA)).toBe(ALICE);
    expect(nextInTurn([], null)).toBeNull();
  });

  it('carries on from a pointer that is not in the team any more', () => {
    expect(nextInTurn([ALICE, CARA], BOB)).toBe(CARA);
    expect(nextInTurn([ALICE, BOB], DEV)).toBe(ALICE);
  });

  it('gives each of four people the same share over a long run', () => {
    const team = [ALICE, BOB, CARA, DEV];
    const counts = new Map<string, number>();
    let last: string | null = null;
    for (let i = 0; i < 400; i += 1) {
      const next = nextInTurn(team, last);
      last = next;
      counts.set(next!, (counts.get(next!) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([100, 100, 100, 100]);
  });
});

describe('evaluateAssignment', () => {
  const roundRobin = rule('rr', 10, {
    action: { type: 'team_round_robin', teamId: TEAM },
    conditions: [eq('city', 'kolkata')],
  });

  it('uses the first matching rule, in position order and not in the order given', () => {
    const rules = [
      rule('late', 30, { action: { type: 'user', userId: CARA } }),
      rule('early', 5, { action: { type: 'user', userId: BOB } }),
    ];
    const decision = evaluateAssignment(rules, {}, context());
    expect(decision).toMatchObject({
      ownerId: BOB,
      ruleId: 'early',
      reason: 'rule',
      pointerUpdate: null,
    });
  });

  it('round-robins a team, asks for the pointer to move, and skips people who are not eligible', () => {
    const decision = evaluateAssignment([roundRobin], { city: 'Kolkata' }, context());
    expect(decision).toMatchObject({
      ownerId: ALICE,
      ruleId: 'rr',
      pointerUpdate: { ruleId: 'rr', userId: ALICE },
    });
    const next = evaluateAssignment(
      [roundRobin],
      { city: 'Kolkata' },
      context({ pointers: new Map([['rr', ALICE]]), eligible: new Set([ALICE, CARA]) }),
    );
    expect(next.ownerId).toBe(CARA);
  });

  it('falls through a rule whose person is no longer eligible, to the next rule', () => {
    const rules = [
      rule('gone', 1, { action: { type: 'user', userId: DEV } }),
      rule('next', 2, { action: { type: 'user', userId: BOB } }),
    ];
    expect(evaluateAssignment(rules, {}, context()).ruleId).toBe('next');
  });

  it('falls through a team with nobody eligible, then to the defaults', () => {
    const decision = evaluateAssignment(
      [roundRobin],
      { city: 'Kolkata' },
      context({ eligible: new Set([ALICE]), teamMembers: new Map([[TEAM, [DEV]]]) }),
    );
    expect(decision).toMatchObject({ ownerId: ALICE, reason: 'fallback', ruleId: null });
  });

  it('a default_owner rule gives the first eligible default', () => {
    const decision = evaluateAssignment([rule('d', 1)], {}, context());
    expect(decision).toMatchObject({ ownerId: ALICE, reason: 'default_owner', ruleId: 'd' });
  });

  it('with no rules the first eligible default gets it; with nobody eligible, nobody', () => {
    expect(evaluateAssignment([], {}, context())).toMatchObject({
      ownerId: ALICE,
      reason: 'fallback',
    });
    expect(evaluateAssignment([], {}, context({ eligible: new Set() }))).toMatchObject({
      ownerId: null,
      reason: 'nobody_eligible',
    });
  });

  it('ignores a rule for another kind of lead', () => {
    const rules = [
      rule('only-import', 1, { appliesTo: ['import'], action: { type: 'user', userId: CARA } }),
    ];
    expect(evaluateAssignment(rules, {}, context()).ruleId).toBeNull();
    expect(evaluateAssignment(rules, {}, context({ trigger: 'import' })).ownerId).toBe(CARA);
  });

  it('is the same answer for the same input, and does not change its input', () => {
    const rules = [roundRobin, rule('x', 20)];
    const frozen = Object.freeze(rules.map((entry) => Object.freeze({ ...entry })));
    const a = evaluateAssignment(frozen, { city: 'kolkata' }, context());
    const b = evaluateAssignment(frozen, { city: 'kolkata' }, context());
    expect(a).toEqual(b);
  });

  it('never throws for odd facts and rules', () => {
    const facts: Record<string, unknown> = { city: { a: 1 }, source: Symbol('s'), x: () => 1 };
    expect(() => evaluateAssignment([roundRobin], facts, context())).not.toThrow();
  });
});

describe('checking a rule before it is saved', () => {
  const known = new Set(['city', 'source', 'form_id', 'interest']);
  const base = {
    name: 'Kolkata leads',
    appliesTo: ['web_form'],
    conditions: [eq('city', 'Kolkata')],
  };

  it('accepts a good rule', () => {
    expect(checkRuleShape(base, known)).toEqual([]);
  });

  it.each([
    ['a blank name', { name: '  ' }],
    ['a name that is too long', { name: 'x'.repeat(81) }],
    ['no kind of lead', { appliesTo: [] }],
    ['an unknown field', { conditions: [eq('nope', 'x')] }],
    ['no value', { conditions: [{ field: 'city', operator: 'equals' as const }] }],
    [
      'a value on is_empty',
      { conditions: [{ field: 'city', operator: 'is_empty' as const, value: 'x' }] },
    ],
    ['an empty in list', { conditions: [{ field: 'city', operator: 'in' as const, value: [] }] }],
    ['a text for in', { conditions: [{ field: 'city', operator: 'in' as const, value: 'a' }] }],
    [
      'a list for equals',
      { conditions: [{ field: 'city', operator: 'equals' as const, value: ['a'] }] },
    ],
    ['a value that is too long', { conditions: [eq('city', 'x'.repeat(201))] }],
    ['too many conditions', { conditions: Array.from({ length: 11 }, () => eq('city', 'x')) }],
  ])('refuses %s', (_label, change) => {
    expect(checkRuleShape({ ...base, ...change }, known).length).toBeGreaterThan(0);
  });
});
