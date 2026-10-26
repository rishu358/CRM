import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { FAILURE_WINDOW_SECONDS, isThrottled, throttleDelayMs } from '@crm/core';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { currentRequestContext } from '../common/request-context.js';
import { AuthRepository } from './auth.repository.js';

/**
 * Brute-force protection (MVP_SPEC M1).
 *
 * > Given 5 failed logins in 10 min, further attempts are delayed and an
 * > `auth_events` row is written.
 *
 * The counter is `auth_events` itself rather than a separate store, so the
 * thing that throttles and the thing an administrator reads when investigating
 * are the same rows. An in-memory counter would also reset on deploy and be
 * per-instance, which is the opposite of what this needs.
 *
 * ## The delay is applied before the answer, whatever the answer is
 *
 * `await throttle.applyDelay(...)` runs before the password is checked, so a
 * correct password is delayed exactly as long as a wrong one. Delaying only
 * failures would make response time a password oracle: an attacker stops
 * reading the body and starts timing it.
 */
@Injectable()
export class AuthThrottleService {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /**
   * Wait out the back-off for this address and source, and record that we did.
   *
   * Returns the delay applied, which the tests assert on — a test that slept
   * and checked nothing would pass just as happily if the delay were removed.
   */
  async applyDelay(email: string | null): Promise<number> {
    const context = currentRequestContext();
    const failures = await this.repository.countRecentFailures({
      email,
      ipAddress: context?.ipAddress ?? null,
      windowSeconds: FAILURE_WINDOW_SECONDS,
    });

    if (!isThrottled(failures)) return 0;

    const ms = throttleDelayMs(failures, this.env.AUTH_THROTTLE_MAX_DELAY_MS);

    // Written before the wait, not after: if the process is restarted mid-delay
    // the evidence that we throttled should already be durable.
    await this.recordEvent('login_throttled', false, { email });
    if (ms > 0) await delay(ms);
    return ms;
  }

  async recordEvent(
    type: string,
    succeeded: boolean,
    details: { email?: string | null; userId?: string | null } = {},
  ): Promise<void> {
    const context = currentRequestContext();
    await this.repository.recordEvent({
      type,
      succeeded,
      email: details.email ?? null,
      userId: details.userId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    });
  }
}
