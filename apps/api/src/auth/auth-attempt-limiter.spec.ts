import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '@crm/core';
import { loadApiEnv } from '../config/env.js';
import { runWithRequestContext, type RequestContext } from '../common/request-context.js';
import { InMemoryCounter } from '../platform/rate-limit/in-memory-counter.js';
import { AuthAttemptLimiter } from './auth-attempt-limiter.service.js';

/**
 * The failed-attempt budgets on their own, without a database (ADR-0064). The end-to-end behaviour
 * through the real sign-in route is `sign-in-limits.security.spec.ts`.
 */
function limiter(overrides: Record<string, string> = {}, counter = new InMemoryCounter()) {
  const env = loadApiEnv({
    DATABASE_URL: 'postgres://unused',
    AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '900',
    AUTH_FAILURE_MAX_PER_ACCOUNT: '3',
    AUTH_FAILURE_MAX_PER_IP: '5',
    ...overrides,
  });
  return new AuthAttemptLimiter(counter, env);
}

function from<T>(ipAddress: string, work: () => T): T {
  const context: RequestContext = {
    requestId: 'test',
    tenantId: null,
    userId: null,
    ipAddress,
    userAgent: null,
    replay: { replayed: false },
  };
  return runWithRequestContext(context, work);
}

async function refusal(run: Promise<unknown>): Promise<RateLimitedError> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RateLimitedError);
  return error as RateLimitedError;
}

describe('the failed-attempt budgets', () => {
  it('lets an account fail up to its budget from any address, then refuses', async () => {
    const attempts = limiter();
    for (let i = 0; i < 3; i += 1)
      await from(`203.0.113.${String(i)}`, () => attempts.reserve('a@example.com'));
    await refusal(from('203.0.113.99', () => attempts.reserve('a@example.com')));
  });

  it('does not count a right password: a slot given back is free again', async () => {
    const attempts = limiter();
    for (let i = 0; i < 20; i += 1) {
      const slot = await from('203.0.113.1', () => attempts.reserve('a@example.com'));
      await slot.release();
    }
    // Twenty correct sign-ins, and the budget of three failures is untouched.
    for (let i = 0; i < 3; i += 1)
      await from('203.0.113.1', () => attempts.reserve('a@example.com'));
  });

  it('counts a failure that happens between successes', async () => {
    const attempts = limiter();
    const ok = await from('203.0.113.1', () => attempts.reserve('a@example.com'));
    await ok.release();
    await from('203.0.113.1', () => attempts.reserve('a@example.com'));
    await from('203.0.113.1', () => attempts.reserve('a@example.com'));
    await from('203.0.113.1', () => attempts.reserve('a@example.com'));
    await refusal(from('203.0.113.1', () => attempts.reserve('a@example.com')));
  });

  it('refuses an address after its budget across different accounts, and only that address', async () => {
    const attempts = limiter();
    for (let i = 0; i < 5; i += 1) {
      await from('203.0.113.7', () => attempts.reserve(`person-${String(i)}@example.com`));
    }
    await refusal(from('203.0.113.7', () => attempts.reserve('another@example.com')));
    await from('203.0.113.8', () => attempts.reserve('another@example.com'));
  });

  it('is exact under a burst: parallel attempts cannot all read "no failures yet"', async () => {
    const attempts = limiter();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        from(`203.0.113.${String(i)}`, () => attempts.reserve('victim@example.com')),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
  });

  it('treats an address typed in another case or with spaces as the same account', async () => {
    const attempts = limiter();
    await from('203.0.113.1', () => attempts.reserve('Person@Example.com'));
    await from('203.0.113.2', () => attempts.reserve(' person@example.com '));
    await from('203.0.113.3', () => attempts.reserve('PERSON@EXAMPLE.COM'));
    await refusal(from('203.0.113.4', () => attempts.reserve('person@example.com')));
  });

  it('counts an unknown name exactly as a known one: it never looks anything up', async () => {
    const counter = new InMemoryCounter();
    const attempts = limiter({}, counter);
    for (let i = 0; i < 3; i += 1) {
      await from('203.0.113.1', () => attempts.reserve('nobody-at-all@example.com'));
    }
    await refusal(from('203.0.113.2', () => attempts.reserve('nobody-at-all@example.com')));
  });

  it('says how long to wait: the longer of the budgets that are spent, never more than the window', async () => {
    const attempts = limiter();
    for (let i = 0; i < 3; i += 1)
      await from('203.0.113.1', () => attempts.reserve('a@example.com'));
    const error = await refusal(from('203.0.113.2', () => attempts.reserve('a@example.com')));
    expect(Number.isInteger(error.retryAfterSeconds)).toBe(true);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('answers with the same words whichever budget was spent, and names neither', async () => {
    const byAccount = limiter();
    for (let i = 0; i < 3; i += 1)
      await from('203.0.113.1', () => byAccount.reserve('a@example.com'));
    const account = await refusal(from('203.0.113.2', () => byAccount.reserve('a@example.com')));

    const byAddress = limiter();
    for (let i = 0; i < 5; i += 1) {
      await from('203.0.113.9', () => byAddress.reserve(`p${String(i)}@example.com`));
    }
    const address = await refusal(from('203.0.113.9', () => byAddress.reserve('q@example.com')));

    expect(account.message).toBe(address.message);
    expect(account.message).not.toMatch(/account|address|budget/i);
  });

  it('keeps nothing a person typed in the keys it counts under', async () => {
    const keys: string[] = [];
    const counter = new InMemoryCounter();
    const spy = {
      hitMany: (entries: Parameters<InMemoryCounter['hitMany']>[0]) => {
        keys.push(...entries.map((entry) => entry.key));
        return counter.hitMany(entries);
      },
      releaseMany: (given: readonly string[]) => counter.releaseMany(given),
    };
    await from('203.0.113.1', () =>
      limiter({}, spy as unknown as InMemoryCounter).reserve('secret.person@example.com'),
    );
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toContain('secret');
      expect(key).not.toContain('@');
    }
  });

  it('never fails a right sign-in because giving the slot back failed', async () => {
    const counter = new InMemoryCounter();
    const broken = {
      hitMany: (entries: Parameters<InMemoryCounter['hitMany']>[0]) => counter.hitMany(entries),
      releaseMany: () => Promise.reject(new Error('redis is down')),
    };
    const slot = await from('203.0.113.1', () =>
      limiter({}, broken as unknown as InMemoryCounter).reserve('a@example.com'),
    );
    await expect(slot.release()).resolves.toBeUndefined();
  });
});
