import { describe, expect, it } from 'vitest';
import {
  MAX_STAGES_PER_PIPELINE,
  STAGE_NAME_MAX_LENGTH,
  canMoveDealsBetween,
  defaultProbabilityFor,
  densePositions,
  insertionIndex,
  normalizeStageName,
  planReorder,
  probabilityFor,
  restoreIndex,
  stageNameKey,
  stageNameProblem,
  stageSetProblems,
  type StageOrderEntry,
} from './index.js';

const s = (id: string, stageType: StageOrderEntry['stageType']): StageOrderEntry => ({
  id,
  stageType,
});

const usual = [s('a', 'open'), s('b', 'open'), s('c', 'open'), s('w', 'won'), s('l', 'lost')];

describe('stage names', () => {
  it('trims and compares without regard to case', () => {
    expect(normalizeStageName('  Proposal sent  ')).toBe('Proposal sent');
    expect(stageNameKey('  PROPOSAL ')).toBe(stageNameKey('proposal'));
  });

  it('refuses an empty name and a name past the limit, and accepts the limit', () => {
    expect(stageNameProblem('   ')).not.toBeNull();
    expect(stageNameProblem('x'.repeat(STAGE_NAME_MAX_LENGTH + 1))).not.toBeNull();
    expect(stageNameProblem('x'.repeat(STAGE_NAME_MAX_LENGTH))).toBeNull();
    expect(stageNameProblem(`  ${'x'.repeat(STAGE_NAME_MAX_LENGTH)}  `)).toBeNull();
  });
});

describe('probability', () => {
  it('is a whole number from 0 to 100 on an open stage', () => {
    expect(probabilityFor('open', 0)).toBe(0);
    expect(probabilityFor('open', 100)).toBe(100);
    expect(probabilityFor('open', 55)).toBe(55);
    expect(probabilityFor('open', -1)).toBeNull();
    expect(probabilityFor('open', 101)).toBeNull();
    expect(probabilityFor('open', 12.5)).toBeNull();
    expect(probabilityFor('open', Number.NaN)).toBeNull();
  });

  it('is fixed on a closed stage: won 100, lost 0', () => {
    expect(probabilityFor('won', 100)).toBe(100);
    expect(probabilityFor('won', 90)).toBeNull();
    expect(probabilityFor('lost', 0)).toBe(0);
    expect(probabilityFor('lost', 10)).toBeNull();
  });

  it('defaults to the fixed value when a stage becomes closed', () => {
    expect(defaultProbabilityFor('won', 30)).toBe(100);
    expect(defaultProbabilityFor('lost', 30)).toBe(0);
    expect(defaultProbabilityFor('open', 30)).toBe(30);
  });
});

describe('the stage set', () => {
  const codes = (stages: StageOrderEntry[]) => stageSetProblems(stages).map((p) => p.code);

  it('accepts open stages followed by won and lost', () => {
    expect(stageSetProblems(usual)).toEqual([]);
  });

  it('needs an open, a won and a lost stage', () => {
    expect(codes([s('w', 'won'), s('l', 'lost')])).toEqual(['no_open_stage']);
    expect(codes([s('a', 'open'), s('l', 'lost')])).toEqual(['no_won_stage']);
    expect(codes([s('a', 'open'), s('w', 'won')])).toEqual(['no_lost_stage']);
    expect(codes([])).toEqual(['no_open_stage', 'no_won_stage', 'no_lost_stage']);
  });

  it('keeps open stages ahead of the closed ones', () => {
    expect(codes([s('a', 'open'), s('w', 'won'), s('b', 'open'), s('l', 'lost')])).toEqual([
      'open_after_closed',
    ]);
  });

  it('allows more than one won or lost stage, in any order among themselves', () => {
    expect(
      stageSetProblems([s('a', 'open'), s('l', 'lost'), s('w', 'won'), s('w2', 'won')]),
    ).toEqual([]);
  });

  it('caps the number of stages at exactly the limit', () => {
    const many = (count: number) => [
      ...Array.from({ length: count - 2 }, (_, i) => s(`o${i}`, 'open')),
      s('w', 'won'),
      s('l', 'lost'),
    ];
    expect(stageSetProblems(many(MAX_STAGES_PER_PIPELINE))).toEqual([]);
    expect(codes(many(MAX_STAGES_PER_PIPELINE + 1))).toEqual(['too_many_stages']);
  });
});

describe('planReorder', () => {
  it('accepts the same stages in a new order', () => {
    expect(planReorder(usual, ['c', 'a', 'b', 'w', 'l'])).toEqual({
      ok: true,
      ids: ['c', 'a', 'b', 'w', 'l'],
    });
  });

  it('refuses a missing id (a stage added since the editor loaded)', () => {
    expect(planReorder(usual, ['a', 'b', 'c', 'w'])).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses an unknown id (another company, a retired stage, a typo)', () => {
    expect(planReorder(usual, ['a', 'b', 'c', 'w', 'zzz'])).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('refuses a repeated id, even when the count would match', () => {
    expect(planReorder(usual, ['a', 'a', 'c', 'w', 'l'])).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('positions', () => {
  it('are dense: 0 to n-1 with no gap or repeat', () => {
    expect(densePositions(4)).toEqual([0, 1, 2, 3]);
    expect(densePositions(0)).toEqual([]);
  });

  it('puts a new open stage after the last open stage, before Won and Lost', () => {
    expect(insertionIndex(usual, 'open')).toBe(3);
  });

  it('puts a new won or lost stage last', () => {
    expect(insertionIndex(usual, 'won')).toBe(5);
    expect(insertionIndex(usual, 'lost')).toBe(5);
  });

  it('puts the first open stage of an empty pipeline first', () => {
    expect(insertionIndex([], 'open')).toBe(0);
  });

  it('restores a stage by the same rule', () => {
    expect(restoreIndex(usual, 'open')).toBe(3);
  });
});

describe('moving deals out of a retired stage', () => {
  it('only into a stage of the same type', () => {
    expect(canMoveDealsBetween('open', 'open')).toBe(true);
    expect(canMoveDealsBetween('won', 'won')).toBe(true);
    expect(canMoveDealsBetween('lost', 'lost')).toBe(true);
    expect(canMoveDealsBetween('open', 'won')).toBe(false);
    expect(canMoveDealsBetween('open', 'lost')).toBe(false);
    expect(canMoveDealsBetween('won', 'lost')).toBe(false);
    expect(canMoveDealsBetween('lost', 'open')).toBe(false);
  });
});
