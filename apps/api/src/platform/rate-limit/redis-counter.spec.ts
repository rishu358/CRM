import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestRedis, type TestRedis } from '../../testing/redis.js';
import { describeRateLimitCounterContract } from './counter.contract.js';
import { RedisCounter, createRateLimitRedis, waitUntilReady } from './redis-counter.js';

let redis: TestRedis;
let client: Redis;
let counter: RedisCounter;

beforeAll(async () => {
  redis = await startTestRedis();
  client = createRateLimitRedis(redis.url);
  expect(await waitUntilReady(client, 5000)).toBe(true);
  counter = new RedisCounter(client);
}, 120_000);

afterAll(async () => {
  client.disconnect();
  await redis.destroy();
});

describeRateLimitCounterContract('RedisCounter', () => counter);

async function withRawRedis<T>(run: (raw: Redis) => Promise<T>): Promise<T> {
  const raw = new Redis(redis.url);
  try {
    return await run(raw);
  } finally {
    raw.disconnect();
  }
}

describe('RedisCounter', () => {
  it('keeps its keys under a versioned prefix, so a shared Redis is not confused', async () => {
    await counter.hitMany([{ key: 'user:prefix-check', windowSeconds: 60 }]);
    await withRawRedis(async (raw) => {
      expect(await raw.get('crm:rl:v1:user:prefix-check')).toBe('1');
      expect(await raw.exists('user:prefix-check')).toBe(0);
    });
  });

  it('puts an expiry on every window, so a key can never outlive it and become a lockout', async () => {
    await counter.hitMany([{ key: 'user:ttl-check', windowSeconds: 60 }]);
    await withRawRedis(async (raw) => {
      const ttl = await raw.pttl('crm:rl:v1:user:ttl-check');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });

  it('repairs a key that somehow has no expiry, instead of limiting it forever', async () => {
    await withRawRedis(async (raw) => {
      await raw.set('crm:rl:v1:user:no-expiry', '41');
      expect(await raw.pttl('crm:rl:v1:user:no-expiry')).toBe(-1);

      const [hit] = await counter.hitMany([{ key: 'user:no-expiry', windowSeconds: 30 }]);
      expect(hit!.count).toBe(42);
      expect(await raw.pttl('crm:rl:v1:user:no-expiry')).toBeGreaterThan(0);
    });
  });

  it('fails at once when Redis cannot be reached, instead of making the request wait', async () => {
    const unreachable = createRateLimitRedis('redis://127.0.0.1:1');
    try {
      const started = performance.now();
      await expect(
        new RedisCounter(unreachable).hitMany([{ key: 'user:x', windowSeconds: 60 }]),
      ).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      unreachable.disconnect();
    }
  });
});
