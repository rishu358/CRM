import type { RateLimitCounter, RateLimitEntry, RateLimitHit } from './counter.js';

/**
 * Counts in this process.
 *
 * A real limit for one API instance and none across several, which is why a deployment with more
 * than one uses `RedisCounter` (ADR-0050). It stays as the floor under it: when Redis cannot be
 * reached the limits fall back to this, so a Redis outage weakens them to per process and never to
 * nothing.
 */
export class InMemoryCounter implements RateLimitCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]> {
    return Promise.resolve(entries.map((entry) => this.hit(entry.key, entry.windowSeconds)));
  }

  private hit(key: string, windowSeconds: number): RateLimitHit {
    const now = this.now();
    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      this.sweep(now);
      return { count: 1, retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds)) };
    }

    existing.count += 1;
    return {
      count: existing.count,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  /** Drop expired windows so a long-running process does not grow unbounded. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
