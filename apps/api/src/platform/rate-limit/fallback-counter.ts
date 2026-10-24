import type { RateLimitCounter, RateLimitEntry, RateLimitHit } from './counter.js';

/**
 * Shared counts when Redis answers, per-process counts when it does not (ADR-0050).
 *
 * The choice when the shared store is down is between three things: refuse every request (a Redis
 * blip becomes an outage, sign-in included), let every request through (the limit disappears at the
 * moment something may be wrong), or keep limiting with what this process knows. The third is the
 * only one that is neither. The limits become per process, which is what they were before Redis,
 * and say so in the log.
 *
 * After a failure Redis is not asked again for `retryAfterMs`, so a down Redis costs one slow
 * request, not one per request. One warning is logged per `reportEveryMs`, and one line when it
 * comes back.
 */
export interface FallbackEvents {
  /** The shared store failed; limits are per process until it is back. */
  degraded(reason: string, failuresSinceLastReport: number): void;
  /** The shared store answered again. */
  recovered(): void;
}

export interface FallbackOptions {
  readonly retryAfterMs?: number;
  readonly reportEveryMs?: number;
  readonly now?: () => number;
}

/** Enough to tell timeout from refused from script error, and never a message that could carry a URL. */
function reasonOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { name, code } = error as { name?: unknown; code?: unknown };
  const parts = [typeof name === 'string' ? name : 'Error', typeof code === 'string' ? code : ''];
  return parts.filter((part) => part !== '').join(' ');
}

export class FallbackCounter implements RateLimitCounter {
  private readonly retryAfterMs: number;
  private readonly reportEveryMs: number;
  private readonly now: () => number;
  private openUntil = 0;
  private degraded = false;
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private failuresSinceReport = 0;

  constructor(
    private readonly shared: RateLimitCounter,
    private readonly local: RateLimitCounter,
    private readonly events: FallbackEvents,
    options: FallbackOptions = {},
  ) {
    this.retryAfterMs = options.retryAfterMs ?? 1000;
    this.reportEveryMs = options.reportEveryMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]> {
    const now = this.now();
    if (now < this.openUntil) return this.local.hitMany(entries);

    try {
      const hits = await this.shared.hitMany(entries);
      if (this.degraded) {
        this.degraded = false;
        this.events.recovered();
      }
      return hits;
    } catch (error) {
      this.openUntil = this.now() + this.retryAfterMs;
      this.degraded = true;
      this.failuresSinceReport += 1;
      if (this.now() - this.lastReportAt >= this.reportEveryMs) {
        this.lastReportAt = this.now();
        this.events.degraded(reasonOf(error), this.failuresSinceReport);
        this.failuresSinceReport = 0;
      }
      return this.local.hitMany(entries);
    }
  }
}
