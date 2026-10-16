import { Inject, Injectable } from '@nestjs/common';
import { RateLimitedError } from '@crm/core';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';

/**
 * Per-tenant rate limiting (CLAUDE.md §5.14).
 *
 * The per-user and per-IP limits are handled by @fastify/rate-limit at the edge.
 * This covers the case those miss: one tenant, many users and many addresses,
 * collectively hammering the API. It runs **after** the actor is resolved, so
 * the tenant is the one membership proved — not a header a caller could spoof
 * to burn through somebody else's budget.
 *
 * ## Known limitation
 *
 * The counters live in this process. That is a real limit for a single
 * instance and no limit at all across several, so this must move to Redis
 * before the API is scaled horizontally. It is written behind an interface for
 * exactly that reason; the Redis implementation replaces `InMemoryCounter`
 * without touching callers.
 */
export interface RateLimitCounter {
  /** Increment the window for `key` and return the new count. */
  hit(key: string, windowSeconds: number): number;
}

export class InMemoryCounter implements RateLimitCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  hit(key: string, windowSeconds: number): number {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      this.sweep(now);
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  /** Drop expired windows so a long-running process does not grow unbounded. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

@Injectable()
export class TenantRateLimitService {
  private readonly counter: RateLimitCounter = new InMemoryCounter();

  constructor(@Inject(API_ENV_TOKEN) private readonly env: ApiEnv) {}

  /** Record a request for this tenant, or throw 429. */
  check(tenantId: string): void {
    const count = this.counter.hit(`tenant:${tenantId}`, this.env.RATE_LIMIT_WINDOW_SECONDS);
    if (count > this.env.RATE_LIMIT_MAX_PER_TENANT) {
      throw new RateLimitedError('This workspace has made too many requests. Try again shortly.');
    }
  }
}
