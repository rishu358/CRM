import { describe, expect, it } from 'vitest';
import {
  resolveStageState,
  StageRuleViolation,
  type DealStageSnapshot,
  type StageFacts,
} from './stage-rules.js';

const NOW = new Date('2026-10-17T10:00:00.000Z');
const EARLIER = new Date('2026-09-01T09:00:00.000Z');

const open: StageFacts = { id: 'open-1', stageType: 'open', probability: 25 };
const otherOpen: StageFacts = { id: 'open-2', stageType: 'open', probability: 60 };
const won: StageFacts = { id: 'won-1', stageType: 'won', probability: 100 };
const lost: StageFacts = { id: 'lost-1', stageType: 'lost', probability: 0 };

const openDeal: DealStageSnapshot = {
  stageId: 'open-1',
  probability: 40,
  closedAt: null,
  lostReason: null,
};

const lostDeal: DealStageSnapshot = {
  stageId: 'lost-1',
  probability: 0,
  closedAt: EARLIER,
  lostReason: 'chose a competitor',
};

describe('moving to a won stage (MVP_SPEC M5 acceptance)', () => {
  it('closes the deal now at probability 100', () => {
    expect(resolveStageState({ stage: won, previous: openDeal, now: NOW })).toEqual({
      probability: 100,
      closedAt: NOW,
      lostReason: null,
    });
  });

  it('does the same for a deal created straight into a won stage', () => {
    expect(resolveStageState({ stage: won, now: NOW })).toMatchObject({
      probability: 100,
      closedAt: NOW,
    });
  });

  it('accepts a probability from the caller only if it agrees', () => {
    expect(resolveStageState({ stage: won, probability: 100, now: NOW }).probability).toBe(100);
    expect(() => resolveStageState({ stage: won, probability: 60, now: NOW })).toThrow(
      StageRuleViolation,
    );
  });

  it('refuses a lost reason', () => {
    expect(() => resolveStageState({ stage: won, lostReason: 'too dear', now: NOW })).toThrow(
      /lost reason/i,
    );
  });

  it('keeps the original closing time through an edit that leaves the stage alone', () => {
    const wonDeal: DealStageSnapshot = {
      stageId: 'won-1',
      probability: 100,
      closedAt: EARLIER,
      lostReason: null,
    };
    expect(resolveStageState({ stage: won, previous: wonDeal, now: NOW }).closedAt).toBe(EARLIER);
  });

  it('re-closes when a lost deal is moved to won, clearing the reason', () => {
    expect(resolveStageState({ stage: won, previous: lostDeal, now: NOW })).toEqual({
      probability: 100,
      closedAt: NOW,
      lostReason: null,
    });
  });
});

describe('moving to a lost stage', () => {
  it('requires a lost reason', () => {
    expect(() => resolveStageState({ stage: lost, previous: openDeal, now: NOW })).toThrow(
      StageRuleViolation,
    );
    for (const blank of [null, '', '   ']) {
      expect(() =>
        resolveStageState({ stage: lost, previous: openDeal, lostReason: blank, now: NOW }),
      ).toThrow(/lost reason is required/i);
    }
  });

  it('closes the deal now at probability 0 and keeps the trimmed reason', () => {
    expect(
      resolveStageState({
        stage: lost,
        previous: openDeal,
        lostReason: '  went with a competitor ',
        now: NOW,
      }),
    ).toEqual({ probability: 0, closedAt: NOW, lostReason: 'went with a competitor' });
  });

  it('names the field to fix', () => {
    try {
      resolveStageState({ stage: lost, now: NOW });
      expect.unreachable();
    } catch (error) {
      expect((error as StageRuleViolation).path).toBe('lostReason');
    }
  });

  it('keeps a reason already on file while the deal stays lost', () => {
    expect(resolveStageState({ stage: lost, previous: lostDeal, now: NOW })).toEqual({
      probability: 0,
      closedAt: EARLIER,
      lostReason: 'chose a competitor',
    });
  });

  it('does not carry a reason across into a fresh loss', () => {
    const wonDeal: DealStageSnapshot = {
      stageId: 'won-1',
      probability: 100,
      closedAt: EARLIER,
      lostReason: null,
    };
    expect(() => resolveStageState({ stage: lost, previous: wonDeal, now: NOW })).toThrow(
      /lost reason is required/i,
    );
  });

  it('refuses a probability other than 0', () => {
    expect(() =>
      resolveStageState({ stage: lost, probability: 10, lostReason: 'x', now: NOW }),
    ).toThrow(/0%/);
  });
});

describe('open stages', () => {
  it('takes the default probability of the stage on arrival', () => {
    expect(resolveStageState({ stage: otherOpen, previous: openDeal, now: NOW })).toEqual({
      probability: 60,
      closedAt: null,
      lostReason: null,
    });
    expect(resolveStageState({ stage: open, now: NOW }).probability).toBe(25);
  });

  it('keeps the probability a rep set while the deal stays in the stage', () => {
    expect(resolveStageState({ stage: open, previous: openDeal, now: NOW }).probability).toBe(40);
  });

  it('lets an explicit probability win', () => {
    expect(
      resolveStageState({ stage: otherOpen, previous: openDeal, probability: 90, now: NOW })
        .probability,
    ).toBe(90);
  });

  it('refuses a lost reason', () => {
    expect(() => resolveStageState({ stage: open, lostReason: 'x', now: NOW })).toThrow(
      /lost stage/i,
    );
  });

  it('reopens a closed deal: closed_at and the reason are cleared', () => {
    expect(resolveStageState({ stage: open, previous: lostDeal, now: NOW })).toEqual({
      probability: 25,
      closedAt: null,
      lostReason: null,
    });
  });
});

describe('keepClosedState (a retired stage tidied away, ADR-0061)', () => {
  const otherWon: StageFacts = { id: 'won-2', stageType: 'won', probability: 100 };
  const otherLost: StageFacts = { id: 'lost-2', stageType: 'lost', probability: 0 };
  const wonDeal: DealStageSnapshot = {
    stageId: 'won-1',
    probability: 100,
    closedAt: EARLIER,
    lostReason: null,
  };

  it('keeps the moment a won deal closed when it moves to another won stage', () => {
    const state = resolveStageState({
      stage: otherWon,
      previous: wonDeal,
      keepClosedState: true,
      now: NOW,
    });
    expect(state).toEqual({ probability: 100, closedAt: EARLIER, lostReason: null });
  });

  it('keeps the closed moment and the reason of a lost deal', () => {
    const state = resolveStageState({
      stage: otherLost,
      previous: lostDeal,
      keepClosedState: true,
      now: NOW,
    });
    expect(state).toEqual({ probability: 0, closedAt: EARLIER, lostReason: 'chose a competitor' });
  });

  it('is what a normal move does not do: without it a won deal closes again now', () => {
    const state = resolveStageState({ stage: otherWon, previous: wonDeal, now: NOW });
    expect(state.closedAt).toEqual(NOW);
  });

  it('does nothing for an open deal moved to another open stage', () => {
    const state = resolveStageState({
      stage: otherOpen,
      previous: openDeal,
      keepClosedState: true,
      now: NOW,
    });
    expect(state).toEqual({ probability: 60, closedAt: null, lostReason: null });
  });

  it('still needs a reason to enter a lost stage from an open deal', () => {
    expect(() =>
      resolveStageState({ stage: lost, previous: openDeal, keepClosedState: true, now: NOW }),
    ).toThrow(StageRuleViolation);
  });
});
