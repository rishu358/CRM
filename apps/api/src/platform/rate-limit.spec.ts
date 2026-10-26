import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '@crm/core';
import { loadApiEnv } from '../config/env.js';
import { ActorRateLimitService, AddressRateLimitService } from './rate-limit.service.js';
import type { RateLimitCounter, RateLimitEntry } from './rate-limit/counter.js';
import { InMemoryCounter } from './rate-limit/in-memory-counter.js';

function env(overrides: Record<string, string>) {
  return loadApiEnv({
    DATABASE_URL: 'postgres://unused',
    AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
    RATE_LIMIT_WINDOW_SECONDS: '60',
    ...overrides,
  });
}

const alice = { userId: 'user-alice', tenantId: 'tenant-a' };
const bob = { userId: 'user-bob', tenantId: 'tenant-a' };

async function refusal(run: Promise<void>): Promise<RateLimitedError> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RateLimitedError);
  return error as RateLimitedError;
}

describe('per-tenant rate limiting (CLAUDE.md §5.14)', () => {
  const service = (maxPerTenant: number) =>
    new ActorRateLimitService(
      new InMemoryCounter(),
      env({ RATE_LIMIT_MAX_PER_TENANT: String(maxPerTenant), RATE_LIMIT_MAX_PER_USER: '1000' }),
    );

  it('allows requests up to the limit', async () => {
    const limiter = service(3);
    await limiter.check(alice);
    await limiter.check(bob);
    await limiter.check(alice);
  });

  it('rejects the request that exceeds it, whoever in the tenant makes it', async () => {
    const limiter = service(2);
    await limiter.check(alice);
    await limiter.check(bob);
    await refusal(limiter.check(alice));
  });

  it('counts each tenant separately', async () => {
    // The point of a per-tenant limit: one noisy workspace must not spend another's budget.
    const limiter = service(2);
    await limiter.check(alice);
    await limiter.check(alice);
    await limiter.check({ userId: 'user-carol', tenantId: 'tenant-b' });
  });

  it('reports 429 with a stable code, not a generic failure', async () => {
    const limiter = service(1);
    await limiter.check(alice);
    const error = await refusal(limiter.check(alice));
    expect(error.httpStatus).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
  });
});

describe('per-user rate limiting (CLAUDE.md §5.14)', () => {
  const service = (maxPerUser: number) =>
    new ActorRateLimitService(
      new InMemoryCounter(),
      env({ RATE_LIMIT_MAX_PER_USER: String(maxPerUser), RATE_LIMIT_MAX_PER_TENANT: '1000' }),
    );

  it('refuses a user who has spent their budget, and not the person next to them', async () => {
    const limiter = service(2);
    await limiter.check(alice);
    await limiter.check(alice);
    await refusal(limiter.check(alice));
    await limiter.check(bob);
  });

  it('follows the user across workspaces: one budget per person, not per membership', async () => {
    const limiter = service(2);
    await limiter.check(alice);
    await limiter.check({ ...alice, tenantId: 'tenant-b' });
    await refusal(limiter.check({ ...alice, tenantId: 'tenant-c' }));
  });

  it('says whose budget it is, and neither the ceiling nor what is left', async () => {
    const limiter = service(1);
    await limiter.check(alice);
    const error = await refusal(limiter.check(alice));
    expect(error.message).not.toMatch(/\d/);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('names the workspace when it is the workspace that is over', async () => {
    const limiter = new ActorRateLimitService(
      new InMemoryCounter(),
      env({ RATE_LIMIT_MAX_PER_USER: '1000', RATE_LIMIT_MAX_PER_TENANT: '1' }),
    );
    await limiter.check(alice);
    const error = await refusal(limiter.check(bob));
    expect(error.message).toContain('workspace');
  });

  it('asks the counter once for both, so a shared store is one round trip', async () => {
    const asked: (readonly RateLimitEntry[])[] = [];
    const counting: RateLimitCounter = {
      hitMany: (entries) => {
        asked.push(entries);
        return new InMemoryCounter().hitMany(entries);
      },
    };
    await new ActorRateLimitService(counting, env({})).check(alice);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.map((entry) => entry.key)).toEqual(['user:user-alice', 'tenant:tenant-a']);
  });
});

describe('the per-address rate limit', () => {
  const service = (maxPerIp: number) =>
    new AddressRateLimitService(
      new InMemoryCounter(),
      env({ RATE_LIMIT_MAX_PER_IP: String(maxPerIp) }),
    );

  it('refuses an address past its budget and not another address', async () => {
    const limiter = service(2);
    await limiter.check('203.0.113.1');
    await limiter.check('203.0.113.1');
    await refusal(limiter.check('203.0.113.1'));
    await limiter.check('203.0.113.2');
  });

  it('is sized for an office, not a person, by default', () => {
    expect(env({}).RATE_LIMIT_MAX_PER_IP).toBe(1000);
    expect(env({}).RATE_LIMIT_MAX_PER_USER).toBe(300);
  });
});
