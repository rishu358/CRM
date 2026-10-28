import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RateLimitedError } from '@crm/core';
import {
  RATE_LIMIT_COUNTER,
  rateLimitKey,
  type RateLimitCounter,
} from '../platform/rate-limit/counter.js';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { currentRequestContext } from '../common/request-context.js';

/**
 * A slot reserved for one sign-in attempt. Give it back when the attempt turns out to be right;
 * keep it (do nothing) when it was wrong.
 */
export interface AttemptReservation {
  /** The password (or code) was right: this attempt does not count against the failure budgets. */
  release(): Promise<void>;
}

/**
 * The hard limits on **failed** sign-ins, per account and per address (CLAUDE.md §5.9, §5.14,
 * ADR-0064).
 *
 * ## Spend first, refund a success
 *
 * An attempt reserves a slot in both budgets *before* the password is checked, and gives it back if
 * the password was right. Reserving first is what makes the limit hold under concurrency: a burst
 * of a thousand parallel guesses at one account cannot all read "no failures yet", because each
 * one takes its slot atomically (a read-then-record limit lets the whole burst through). Refunding
 * a success is what stops people signing in correctly from using up the budget that is meant for
 * people signing in wrongly: fifty colleagues behind one office address are fifty successes and no
 * failures (finding F8).
 *
 * ## Per account, whatever the address
 *
 * The account budget is keyed on the email, not on where the request came from, so rotating
 * addresses (or the `X-Forwarded-For` header that carries one) does not buy more guesses at one
 * account. The email is hashed in the key: a key never holds what a person typed.
 *
 * ## Unknown and known accounts are the same
 *
 * The slot is taken before the account is looked up and is kept on every failure, so an address
 * that has no account is refused after the same number of attempts, with the same answer, as one
 * that has. Nothing here reads the account.
 *
 * ## The cost, said plainly
 *
 * Someone who knows an email can spend that account's failure budget and make its owner wait out
 * the window. That is the price of a hard limit, and it is bounded: the budget is ten a window, a
 * password reset is a different route and stays open, and the attacker's own address pays from its
 * own budget as well. The progressive delay (`AuthThrottleService`) still slows the first few.
 */
@Injectable()
export class AuthAttemptLimiter {
  constructor(
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /** Take a slot for this attempt, or throw a 429 when either budget is spent. */
  async reserve(email: string): Promise<AttemptReservation> {
    const ip = currentRequestContext()?.ipAddress ?? 'unknown';
    const windowSeconds = this.env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
    const accountKey = rateLimitKey('auth-account-fail', accountSubject(email));
    const ipKey = rateLimitKey('auth-ip-fail', ip);

    const [account, address] = await this.counter.hitMany([
      { key: accountKey, windowSeconds },
      { key: ipKey, windowSeconds },
    ]);
    if (account === undefined || address === undefined) {
      throw new Error('A rate limit counter answered fewer hits than it was asked for');
    }

    const accountSpent = account.count > this.env.AUTH_FAILURE_MAX_PER_ACCOUNT;
    const addressSpent = address.count > this.env.AUTH_FAILURE_MAX_PER_IP;
    if (accountSpent || addressSpent) {
      // The slot stays spent: a refused attempt is not a success. Both messages are the generic
      // one, and the wait is the longer of the budgets that are spent, so it is not too short.
      const waits = [
        ...(accountSpent ? [account.retryAfterSeconds] : []),
        ...(addressSpent ? [address.retryAfterSeconds] : []),
      ];
      throw new RateLimitedError(
        'Too many attempts. Try again in a few minutes.',
        Math.max(...waits),
      );
    }

    return {
      release: async () => {
        try {
          await this.counter.releaseMany([accountKey, ipKey]);
        } catch {
          // Bookkeeping must never fail a sign-in that was correct. The slot stays spent until
          // the window ends, which errs on the cautious side.
        }
      },
    };
  }
}

/** What identifies an account in a limit key: a hash, never the address typed. */
function accountSubject(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
