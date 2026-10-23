import { Inject, Injectable } from '@nestjs/common';
import { RateLimitedError } from '@crm/core';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import {
  RATE_LIMIT_COUNTER,
  hitOnce,
  rateLimitKey,
  type RateLimitCounter,
} from './rate-limit/counter.js';

/**
 * Per-user and per-tenant rate limits (CLAUDE.md §5.14, ADR-0042).
 *
 * Both run **after** the actor is resolved, so the user and the tenant are the ones the session and the
 * membership proved, not a header a caller could spoof to spend somebody else's budget. They share one
 * round trip to the counter.
 *
 * The user limit used to live in a plugin that ran before authentication, where there was no user, so
 * it limited the address instead: an office behind one NAT address shared one budget and one person on
 * two addresses had two. It is checked here for the reason the tenant limit is.
 *
 * The counter is Redis when `REDIS_URL` is set, so the budget holds across every API instance, and
 * this process's own counts when it is not or when Redis cannot be reached (`FallbackCounter`).
 */
@Injectable()
export class ActorRateLimitService {
  constructor(
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /** Record a request for this user and tenant, or throw 429. */
  async check(actor: { readonly userId: string; readonly tenantId: string }): Promise<void> {
    const windowSeconds = this.env.RATE_LIMIT_WINDOW_SECONDS;
    const [user, tenant] = await this.counter.hitMany([
      { key: rateLimitKey('user', actor.userId), windowSeconds },
      { key: rateLimitKey('tenant', actor.tenantId), windowSeconds },
    ]);
    if (user === undefined || tenant === undefined) {
      throw new Error('A rate limit counter answered fewer hits than it was asked for');
    }

    // The messages say whose budget it is and nothing else: not the ceiling, not what is left.
    if (tenant.count > this.env.RATE_LIMIT_MAX_PER_TENANT) {
      throw new RateLimitedError(
        'This workspace has made too many requests. Try again shortly.',
        tenant.retryAfterSeconds,
      );
    }
    if (user.count > this.env.RATE_LIMIT_MAX_PER_USER) {
      throw new RateLimitedError(
        'You are sending requests too quickly. Try again shortly.',
        user.retryAfterSeconds,
      );
    }
  }
}

/**
 * What one address may send before anything is known about the caller.
 *
 * This is the only limit that applies to a request with no valid session, which is also what a flood
 * of requests with made-up tokens looks like (each one costs a session lookup). It is sized for an
 * office behind one address, not for one person; the user limit above is the one that is.
 */
@Injectable()
export class AddressRateLimitService {
  constructor(
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  async check(address: string): Promise<void> {
    const hit = await hitOnce(
      this.counter,
      rateLimitKey('ip', address),
      this.env.RATE_LIMIT_WINDOW_SECONDS,
    );
    if (hit.count > this.env.RATE_LIMIT_MAX_PER_IP) {
      throw new RateLimitedError(
        'Too many requests from this address. Try again shortly.',
        hit.retryAfterSeconds,
      );
    }
  }
}
