import { describe, expect, it } from 'vitest';
import type { RateLimitCounter, RateLimitEntry, RateLimitHit } from './counter.js';
import { FallbackCounter, type FallbackEvents } from './fallback-counter.js';
import { InMemoryCounter } from './in-memory-counter.js';

/** A shared counter that can be taken away. Its error carries a password, which must never be logged. */
class Flaky implements RateLimitCounter {
  down = false;
  calls = 0;
  private readonly inner = new InMemoryCounter();

  hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]> {
    this.calls += 1;
    if (this.down) {
      const error = new Error('connect ECONNREFUSED redis://:hunter2@10.0.0.5:6379');
      return Promise.reject(Object.assign(error, { code: 'ECONNREFUSED' }));
    }
    return this.inner.hitMany(entries);
  }

  releaseMany(keys: readonly string[]): Promise<void> {
    if (this.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    return this.inner.releaseMany(keys);
  }
}

function setup(options: { retryAfterMs?: number; reportEveryMs?: number } = {}) {
  let now = 1_000;
  const shared = new Flaky();
  const local = new InMemoryCounter(() => now);
  const events = { degraded: [] as [string, number][], recovered: 0 };
  const sink: FallbackEvents = {
    degraded: (reason, failures) => events.degraded.push([reason, failures]),
    recovered: () => (events.recovered += 1),
  };
  const counter = new FallbackCounter(shared, local, sink, { ...options, now: () => now });
  const hit = (key = 'k') => counter.hitMany([{ key, windowSeconds: 60 }]).then(([h]) => h!);
  return { shared, events, hit, tick: (ms: number) => (now += ms) };
}

describe('the counter that falls back to this process when Redis is down', () => {
  it('uses the shared counter while it works', async () => {
    const { hit, shared, events } = setup();
    expect((await hit()).count).toBe(1);
    expect((await hit()).count).toBe(2);
    expect(shared.calls).toBe(2);
    expect(events.degraded).toEqual([]);
  });

  it('keeps limiting when the shared counter fails: per process, not unlimited and not an error', async () => {
    const { hit, shared } = setup();
    shared.down = true;
    expect((await hit()).count).toBe(1);
    expect((await hit()).count).toBe(2);
    expect((await hit()).count).toBe(3);
  });

  it('does not ask a failing shared counter again at once, so a down Redis costs one slow request', async () => {
    const { hit, shared, tick } = setup({ retryAfterMs: 1000 });
    shared.down = true;
    await hit();
    await hit();
    await hit();
    expect(shared.calls).toBe(1);

    tick(1000);
    await hit();
    expect(shared.calls).toBe(2);
  });

  it('reports once, not once per request, and never what the error said', async () => {
    const { hit, shared, events, tick } = setup({ retryAfterMs: 10, reportEveryMs: 30_000 });
    shared.down = true;
    for (let i = 0; i < 5; i += 1) {
      await hit();
      tick(20);
    }
    expect(events.degraded).toHaveLength(1);
    expect(events.degraded[0]![0]).toBe('Error ECONNREFUSED');
    expect(JSON.stringify(events.degraded)).not.toMatch(/hunter2|10\.0\.0\.5|redis:\/\//);

    tick(30_000);
    await hit();
    expect(events.degraded).toHaveLength(2);
    expect(events.degraded[1]![1]).toBeGreaterThan(0);
  });

  it('goes back to the shared counter when it answers again, and says so once', async () => {
    const { hit, shared, events, tick } = setup({ retryAfterMs: 1000 });
    shared.down = true;
    await hit();
    shared.down = false;
    tick(1000);

    const recovered = await hit();
    expect(recovered.count).toBe(1);
    expect(events.recovered).toBe(1);
    await hit();
    expect(events.recovered).toBe(1);
  });
});
