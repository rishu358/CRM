import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { RateLimitedError } from '@crm/core';
import {
  RATE_LIMIT_COUNTER,
  hitOnce,
  rateLimitKey,
  type RateLimitCounter,
} from '../platform/rate-limit/counter.js';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { currentRequestContext } from '../common/request-context.js';
import { PUBLIC_ROUTE_KEY } from './auth.guard.js';

/**
 * A tighter ceiling on the unauthenticated auth endpoints (CLAUDE.md §5.14).
 *
 * The general limiter keys on the user once one is known, and falls back to
 * the IP otherwise — at a budget sized for ordinary API traffic. Sign-in,
 * sign-up and password reset have no user to key on and no business being
 * called three hundred times a minute from one address, so they get their own,
 * much smaller allowance.
 *
 * This is a **different control** from the progressive delay in
 * `AuthThrottleService`, and both are needed. The delay is per account and
 * slows guessing at one password; this is per source and bounds how much
 * traffic one host can aim at the whole surface — including spraying one
 * common password across many different addresses, which the per-account delay
 * would never see.
 *
 * The count is shared across API instances when `REDIS_URL` is set (ADR-0042), so
 * a host cannot multiply its allowance by the number of instances behind the load
 * balancer. If Redis cannot be reached it is this process's own count, which is
 * the limit it had before it was shared.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler() as { [PUBLIC_ROUTE_KEY]?: boolean };

    // Only the routes that take no session. An authenticated route is already
    // covered per user, and applying this to the security screen's polling
    // would lock people out of reading their own device list.
    if (handler[PUBLIC_ROUTE_KEY] !== true) return true;

    const ip = currentRequestContext()?.ipAddress ?? 'unknown';
    const hit = await hitOnce(
      this.counter,
      rateLimitKey('auth-ip', ip),
      this.env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    );

    if (hit.count > this.env.AUTH_RATE_LIMIT_MAX_PER_IP) {
      // The same generic message for every caller. Saying which limit was hit,
      // or how much is left, tells an attacker how to pace themselves.
      throw new RateLimitedError(
        'Too many attempts. Try again in a few minutes.',
        hit.retryAfterSeconds,
      );
    }
    return true;
  }
}
