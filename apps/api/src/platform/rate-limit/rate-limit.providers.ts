import type { OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createLogger } from '../../common/logger.js';
import type { ApiEnv } from '../../config/env.js';
import type { RateLimitCounter, RateLimitEntry, RateLimitHit } from './counter.js';
import { FallbackCounter } from './fallback-counter.js';
import { InMemoryCounter } from './in-memory-counter.js';
import { RedisCounter, createRateLimitRedis, waitUntilReady } from './redis-counter.js';

/**
 * The counter the application provides as `RATE_LIMIT_COUNTER` (ADR-0053).
 *
 * Owns the Redis connection, so that closing the application closes it.
 */
export class ManagedRateLimitCounter implements RateLimitCounter, OnApplicationShutdown {
  constructor(
    private readonly inner: RateLimitCounter,
    private readonly client: Redis | null,
  ) {}

  hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]> {
    return this.inner.hitMany(entries);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client === null) return;
    try {
      await this.client.quit();
    } catch {
      // Redis is already gone; there is nothing left to close politely.
      this.client.disconnect();
    }
  }
}

/** Shared counts through Redis when `REDIS_URL` is set, this process's own when it is not. */
export async function createRateLimitCounter(env: ApiEnv): Promise<ManagedRateLimitCounter> {
  const local = new InMemoryCounter();
  if (env.REDIS_URL === undefined || env.REDIS_URL === '') {
    return new ManagedRateLimitCounter(local, null);
  }

  const logger = createLogger(env.LOG_LEVEL, false);
  const client = createRateLimitRedis(env.REDIS_URL);
  // Not being ready in time is not fatal: the client keeps connecting and, until it has, limits are
  // per process. Starting without Redis is exactly what an outage does later.
  const ready = await waitUntilReady(client, 1500);
  if (!ready) {
    logger.warn(
      { component: 'rate-limit' },
      'Redis is not reachable yet: rate limits are per process until it is',
    );
  }

  const counter = new FallbackCounter(new RedisCounter(client), local, {
    degraded: (reason, failures) =>
      logger.warn(
        { component: 'rate-limit', reason, failures },
        'Redis is not answering: rate limits are per process until it is',
      ),
    recovered: () =>
      logger.info({ component: 'rate-limit' }, 'Redis is answering again: rate limits are shared'),
  });
  return new ManagedRateLimitCounter(counter, client);
}
