import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '@crm/core';
import { loadApiEnv } from '../config/env.js';
import { InMemoryCounter, TenantRateLimitService } from './rate-limit.service.js';

function service(maxPerTenant: number, windowSeconds = 60): TenantRateLimitService {
  return new TenantRateLimitService(
    loadApiEnv({
      DATABASE_URL: 'postgres://unused',
      AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
      RATE_LIMIT_MAX_PER_TENANT: String(maxPerTenant),
      RATE_LIMIT_WINDOW_SECONDS: String(windowSeconds),
    }),
  );
}

describe('per-tenant rate limiting (CLAUDE.md §5.14)', () => {
  it('allows requests up to the limit', () => {
    const limiter = service(3);
    expect(() => {
      limiter.check('tenant-a');
      limiter.check('tenant-a');
      limiter.check('tenant-a');
    }).not.toThrow();
  });

  it('rejects the request that exceeds it', () => {
    const limiter = service(2);
    limiter.check('tenant-a');
    limiter.check('tenant-a');
    expect(() => limiter.check('tenant-a')).toThrow(RateLimitedError);
  });

  it('counts each tenant separately', () => {
    // The point of a per-tenant limit: one noisy workspace must not spend
    // another's budget.
    const limiter = service(2);
    limiter.check('tenant-a');
    limiter.check('tenant-a');
    expect(() => limiter.check('tenant-b')).not.toThrow();
  });

  it('reports 429, not a generic failure', () => {
    const limiter = service(1);
    limiter.check('tenant-a');
    try {
      limiter.check('tenant-a');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RateLimitedError).httpStatus).toBe(429);
      expect((error as RateLimitedError).code).toBe('RATE_LIMITED');
    }
  });
});

describe('InMemoryCounter', () => {
  it('starts a fresh window once the old one expires', () => {
    const counter = new InMemoryCounter();
    // A zero-length window is already expired by the next call.
    expect(counter.hit('k', 0)).toBe(1);
    expect(counter.hit('k', 0)).toBe(1);
  });

  it('accumulates within a window', () => {
    const counter = new InMemoryCounter();
    expect(counter.hit('k', 60)).toBe(1);
    expect(counter.hit('k', 60)).toBe(2);
    expect(counter.hit('k', 60)).toBe(3);
  });

  it('keeps keys independent', () => {
    const counter = new InMemoryCounter();
    counter.hit('a', 60);
    counter.hit('a', 60);
    expect(counter.hit('b', 60)).toBe(1);
  });
});
