import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { RateLimitCounter } from './counter.js';

/**
 * What every `RateLimitCounter` must do, whatever it counts in (ADR-0050).
 *
 * Used by the in-process counter and the Redis counter, so the shared one is held to exactly what
 * the one it replaces always did. Keys are unique per test, because the Redis counter outlives a
 * test and a key left over from another would be somebody else's count.
 */
export function describeRateLimitCounterContract(
  name: string,
  make: () => RateLimitCounter | Promise<RateLimitCounter>,
): void {
  const fresh = (label: string) => `contract:${label}:${randomUUID()}`;

  describe(`${name}: the rate limit counter contract`, () => {
    it('counts hits within a window, starting at one', async () => {
      const counter = await make();
      const key = fresh('count');
      const counts: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const [hit] = await counter.hitMany([{ key, windowSeconds: 60 }]);
        counts.push(hit!.count);
      }
      expect(counts).toEqual([1, 2, 3]);
    });

    it('keeps keys independent', async () => {
      const counter = await make();
      const a = fresh('a');
      const b = fresh('b');
      await counter.hitMany([{ key: a, windowSeconds: 60 }]);
      await counter.hitMany([{ key: a, windowSeconds: 60 }]);
      const [hit] = await counter.hitMany([{ key: b, windowSeconds: 60 }]);
      expect(hit!.count).toBe(1);
    });

    it('answers several entries in the order asked, and counts each', async () => {
      const counter = await make();
      const user = fresh('user');
      const tenant = fresh('tenant');
      await counter.hitMany([{ key: tenant, windowSeconds: 60 }]);
      await counter.hitMany([{ key: tenant, windowSeconds: 60 }]);

      const hits = await counter.hitMany([
        { key: user, windowSeconds: 60 },
        { key: tenant, windowSeconds: 60 },
      ]);
      expect(hits.map((hit) => hit.count)).toEqual([1, 3]);
    });

    it('answers nothing for nothing', async () => {
      const counter = await make();
      expect(await counter.hitMany([])).toEqual([]);
    });

    it('says how long until the window ends: a whole number of seconds, at least one, at most the window', async () => {
      const counter = await make();
      const [first] = await counter.hitMany([{ key: fresh('retry'), windowSeconds: 30 }]);
      expect(Number.isInteger(first!.retryAfterSeconds)).toBe(true);
      expect(first!.retryAfterSeconds).toBeGreaterThanOrEqual(29);
      expect(first!.retryAfterSeconds).toBeLessThanOrEqual(30);
    });

    it('does not count every hit against the same window forever: it starts again at one', async () => {
      const counter = await make();
      const key = fresh('expiry');
      await counter.hitMany([{ key, windowSeconds: 1 }]);
      const [second] = await counter.hitMany([{ key, windowSeconds: 1 }]);
      expect(second!.count).toBe(2);

      await sleep(1150);
      const [afterwards] = await counter.hitMany([{ key, windowSeconds: 1 }]);
      expect(afterwards!.count).toBe(1);
    });

    it('does not extend a window by being hit again: it is fixed, not sliding', async () => {
      const counter = await make();
      const key = fresh('fixed');
      const [first] = await counter.hitMany([{ key, windowSeconds: 3 }]);
      expect(first!.retryAfterSeconds).toBe(3);

      await sleep(1100);
      const [second] = await counter.hitMany([{ key, windowSeconds: 3 }]);
      // About 1.9 s left, and a hit in between did not push it back to three.
      expect(second!.retryAfterSeconds).toBeLessThanOrEqual(2);
    });

    it('counts exactly under concurrency: no hit lost, none counted twice', async () => {
      const counter = await make();
      const key = fresh('concurrent');
      const hits = await Promise.all(
        Array.from({ length: 200 }, () => counter.hitMany([{ key, windowSeconds: 60 }])),
      );
      const counts = hits.map(([hit]) => hit!.count).sort((x, y) => x - y);
      expect(counts).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    });
  });
}
