import { Redis, type ChainableCommander } from 'ioredis';
import type { RateLimitCounter, RateLimitEntry, RateLimitHit } from './counter.js';

/**
 * Counts in Redis, so every API instance spends from the same budget (ADR-0053).
 *
 * One atomic script per key: increment, and start the window on the first hit. Doing it as two
 * commands would let a crash between them leave a key that never expires, which is a lockout. The
 * script also repairs a key that somehow has no expiry (`PTTL < 0`), for the same reason.
 *
 * Several keys are sent in one pipeline, so a request counted against its user and its tenant
 * costs one round trip. Each key is its own script call, so this works on a clustered Redis too.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const COMMAND = 'crmRateLimitHit';

/** Namespaced and versioned, so a shared Redis is not confused and a later format can coexist. */
const KEY_PREFIX = 'crm:rl:v1:';

type HitResult = readonly [number, number];

interface WithHit {
  crmRateLimitHit(key: string, windowMs: number): Promise<HitResult>;
}

type PipelineWithHit = ChainableCommander & {
  crmRateLimitHit(key: string, windowMs: number): ChainableCommander;
};

/**
 * A client built for a limiter that must never be the thing that makes a request wait.
 *
 * - No offline queue: while Redis is unreachable a command fails at once instead of waiting for it.
 * - One attempt and a short command timeout: a slow Redis is treated as an unreachable one.
 * - It reconnects in the background, so the limiter recovers by itself.
 */
export function createRateLimitRedis(url: string): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 150,
    connectTimeout: 1500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // ioredis reports connection trouble as an `error` event and throws if nobody listens. The
  // limiter's fallback is what reports it, once, not once per attempt.
  client.on('error', () => undefined);
  return client;
}

/**
 * Give a new connection a moment to become ready before it is used. Without it the first requests of a
 * process find the client still connecting, and (with no offline queue) take the per-process fallback.
 * Not being ready in time is not an error: the client keeps connecting and the limiter recovers.
 */
export async function waitUntilReady(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ready);
    };
    const onReady = () => finish(true);
    client.once('ready', onReady);
  });
}

export class RedisCounter implements RateLimitCounter {
  constructor(private readonly client: Redis) {
    if (typeof (client as unknown as Partial<WithHit>).crmRateLimitHit !== 'function') {
      client.defineCommand(COMMAND, { numberOfKeys: 1, lua: HIT_SCRIPT });
    }
  }

  async hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]> {
    if (entries.length === 0) return [];

    const pipeline = this.client.pipeline() as PipelineWithHit;
    for (const entry of entries) {
      pipeline.crmRateLimitHit(
        `${KEY_PREFIX}${entry.key}`,
        Math.max(1, entry.windowSeconds * 1000),
      );
    }
    const results = await pipeline.exec();
    if (results === null || results.length !== entries.length) {
      throw new Error('Redis answered a rate limit pipeline with the wrong number of results');
    }

    return results.map(([error, value]) => {
      if (error !== null) throw error;
      const [count, ttlMs] = value as HitResult;
      return { count, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    });
  }
}
