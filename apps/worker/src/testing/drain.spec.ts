import { describe, expect, it } from 'vitest';
import type { OutboxRelay } from '../relay.js';
import { drainRelay, type PendingProbe } from './drain.js';

/**
 * The drain used by the worker suites.
 *
 * Its job is narrow and the failure it prevents is subtle, so each case below
 * is a way the loop could be wrong: stopping too early (the original bug),
 * waiting forever, or waiting when there is nothing to wait for.
 */
function fakeRelay(script: number[]): { relay: OutboxRelay; ticks: () => number } {
  let calls = 0;
  const relay = {
    tick: () => {
      const next = script[calls] ?? 0;
      calls += 1;
      return Promise.resolve(next);
    },
  } as unknown as OutboxRelay;
  return { relay, ticks: () => calls };
}

function probe(answers: boolean[]): { pool: PendingProbe; asked: () => number } {
  let asked = 0;
  return {
    pool: {
      query: () => {
        const due = answers[asked] ?? false;
        asked += 1;
        return Promise.resolve({ rows: due ? [{ '?column?': 1 }] : [] });
      },
    },
    asked: () => asked,
  };
}

describe('drainRelay', () => {
  it('keeps going after an empty pass when an event is about to be due', async () => {
    // The bug: pass 1 finds nothing because the event is a few milliseconds in
    // the claimer's future (a clock step), and the old loop stopped right there.
    const { relay, ticks } = fakeRelay([0, 2, 0]);
    const { pool } = probe([true, false]);

    const total = await drainRelay(relay, pool, { limit: 10, waitMs: 1 });

    expect(total).toBe(2);
    expect(ticks()).toBe(3);
  });

  it('stops on an empty pass when nothing is about to be due', async () => {
    const { relay, ticks } = fakeRelay([3, 0, 5]);
    const { pool, asked } = probe([false]);

    const total = await drainRelay(relay, pool, { limit: 10, waitMs: 1 });

    // The 5 after the empty pass is never reached: nothing was due, so it ended.
    expect(total).toBe(3);
    expect(ticks()).toBe(2);
    expect(asked()).toBe(1);
  });

  it('gives up waiting rather than hanging on an event that never arrives', async () => {
    const { relay } = fakeRelay([]);
    const { pool, asked } = probe(Array.from({ length: 100 }, () => true));

    const total = await drainRelay(relay, pool, { limit: 1000, maxWaits: 4, waitMs: 1 });

    expect(total).toBe(0);
    // Four waits, then one more look that finds the budget spent.
    expect(asked()).toBe(5);
  });

  it('does not ask the database while passes are still claiming events', async () => {
    const { relay } = fakeRelay([4, 4, 4, 0]);
    const { pool, asked } = probe([false]);

    await drainRelay(relay, pool, { limit: 10, waitMs: 1 });

    expect(asked()).toBe(1);
  });

  it('respects the pass limit even when every pass claims something', async () => {
    const { relay, ticks } = fakeRelay(Array.from({ length: 100 }, () => 1));
    const { pool } = probe([]);

    const total = await drainRelay(relay, pool, { limit: 7, waitMs: 1 });

    expect(total).toBe(7);
    expect(ticks()).toBe(7);
  });
});
