import { describe, expect, it } from 'vitest';
import { describeRateLimitCounterContract } from './counter.contract.js';
import { InMemoryCounter } from './in-memory-counter.js';

describeRateLimitCounterContract('InMemoryCounter', () => new InMemoryCounter());

describe('InMemoryCounter', () => {
  it('starts a fresh window once the old one has ended, by the clock it is given', async () => {
    let now = 1_000_000;
    const counter = new InMemoryCounter(() => now);
    const hit = () => counter.hitMany([{ key: 'k', windowSeconds: 60 }]).then(([h]) => h!);

    expect((await hit()).count).toBe(1);
    now += 59_000;
    expect((await hit()).count).toBe(2);
    expect((await hit()).retryAfterSeconds).toBe(1);
    now += 1_000;
    expect((await hit()).count).toBe(1);
  });

  it('forgets windows that have ended, so a long-running process does not grow without bound', async () => {
    let now = 0;
    const counter = new InMemoryCounter(() => now);
    for (let i = 0; i < 10_001; i += 1) {
      await counter.hitMany([{ key: `old:${String(i)}`, windowSeconds: 1 }]);
    }
    now += 5_000;
    await counter.hitMany([{ key: 'new', windowSeconds: 1 }]);
    const windows = (counter as unknown as { windows: Map<string, unknown> }).windows;
    expect(windows.size).toBeLessThan(10);
  });
});
