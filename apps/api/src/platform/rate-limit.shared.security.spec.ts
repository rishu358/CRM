import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';
import { startTestRedis, type TestRedis } from '../testing/redis.js';

/**
 * Rate limits hold across API instances (CLAUDE.md §5.14, ADR-0053).
 *
 * Two real instances of the application, one database, one Redis. The point of sharing the counters is
 * that a limit means the same thing however many instances sit behind the load balancer, so each test
 * spends a budget partly on one instance and partly on the other and asks both to refuse at the end.
 * Counted per process the same traffic would be allowed twice over.
 */
const USER_LIMIT = 4;
const TENANT_LIMIT = 6;
const IP_LIMIT = 5;
const AUTH_IP_LIMIT = 3;

let redis: TestRedis;
let a: ApiHarness;
let b: ApiHarness;
let nextHost = 1;

/** Every call from its own address unless a test says otherwise, so the address limit is not the one being spent. */
const freshAddress = () => `198.51.100.${String(nextHost++)}`;

const me = (harness: ApiHarness, token: string, remoteAddress = freshAddress()) =>
  request(harness, { method: 'GET', url: '/api/v1/auth/me', token, remoteAddress });

async function workspace(label: string): Promise<{ tenantId: string; users: string[] }> {
  const tenantId = (await a.fixtures.createTenant({ name: `Shared limits ${label}` })).tenantId;
  const roles = await a.provision(tenantId);
  const users: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const user = await a.fixtures.createUser(tenantId, roles.get('Admin')!);
    users.push(await a.signIn(user.userId, tenantId));
  }
  return { tenantId, users };
}

beforeAll(async () => {
  redis = await startTestRedis();
  const shared = {
    REDIS_URL: redis.url,
    RATE_LIMIT_WINDOW_SECONDS: '600',
    RATE_LIMIT_MAX_PER_USER: String(USER_LIMIT),
    RATE_LIMIT_MAX_PER_TENANT: String(TENANT_LIMIT),
    RATE_LIMIT_MAX_PER_IP: String(IP_LIMIT),
    AUTH_RATE_LIMIT_MAX_PER_IP: String(AUTH_IP_LIMIT),
  };
  a = await startApiHarness(inject('dbUrls'), shared);
  b = await startApiHarness(inject('dbUrls'), shared);
}, 240_000);

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
  await redis.destroy();
});

describe('two instances share one budget', () => {
  it('per user: one person cannot spend the limit once on each instance', async () => {
    const { users } = await workspace('user');
    const [alice] = users as [string];

    const first = [(await me(a, alice)).status, (await me(b, alice)).status];
    const second = [(await me(a, alice)).status, (await me(b, alice)).status];
    expect([...first, ...second]).toEqual([200, 200, 200, 200]);

    // Four spent between the two of them; either refuses a fifth. Counted per process each would
    // have allowed four of its own.
    expect((await me(a, alice)).status).toBe(429);
    expect((await me(b, alice)).status).toBe(429);
  });

  it('per tenant: a workspace cannot spend its limit once on each instance', async () => {
    const { users } = await workspace('tenant');
    const [u1, u2, u3] = users as [string, string, string];

    // Six requests across three people and two instances, none of them over their own limit of four.
    const statuses = [
      (await me(a, u1)).status,
      (await me(b, u1)).status,
      (await me(a, u2)).status,
      (await me(b, u2)).status,
      (await me(a, u3)).status,
      (await me(b, u3)).status,
    ];
    expect(statuses).toEqual(Array(6).fill(200));

    const refused = await me(a, u3);
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).toContain('workspace');
    expect((await me(b, u1)).status).toBe(429);
  });

  it('per address, before anyone has signed in', async () => {
    const address = freshAddress();
    const statuses: number[] = [];
    for (let i = 0; i < IP_LIMIT; i += 1) {
      statuses.push((await me(i % 2 === 0 ? a : b, 'a'.repeat(43), address)).status);
    }
    expect(statuses).toEqual(Array(IP_LIMIT).fill(401));
    expect((await me(a, 'a'.repeat(43), address)).status).toBe(429);
    expect((await me(b, 'a'.repeat(43), address)).status).toBe(429);
  });

  it('on the sign-in routes, so a host cannot spray passwords through every instance in turn', async () => {
    const address = freshAddress();
    const attempt = (harness: ApiHarness) =>
      request(harness, {
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        body: { email: `nobody-${String(nextHost++)}@example.com`, password: 'Wrong-password-1!' },
        remoteAddress: address,
      }).then((response) => response.status);

    const statuses = [await attempt(a), await attempt(b), await attempt(a)];
    expect(statuses).toEqual([401, 401, 401]);
    expect(await attempt(b)).toBe(429);
    expect(await attempt(a)).toBe(429);
  }, 60_000);

  it('keeps nothing in Redis that a person typed: only ids and addresses, under a prefix, with an expiry', async () => {
    const { users } = await workspace('keys');
    await me(a, users[0]!);

    const raw = new Redis(redis.url);
    try {
      const keys = await raw.keys('*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/^crm:rl:v1:(user|tenant|ip|auth-ip):[0-9a-f.:-]+$/);
        expect(await raw.pttl(key)).toBeGreaterThan(0);
      }
    } finally {
      raw.disconnect();
    }
  });
});

describe('when Redis goes away', () => {
  it('keeps serving and keeps limiting per process, then shares again when it is back', async () => {
    const { users } = await workspace('outage');
    const [alice] = users as [string];

    await redis.stop();

    // No error and no stall: a refusal to reach Redis is not a refusal to serve.
    const started = performance.now();
    const during: number[] = [];
    for (let i = 0; i < USER_LIMIT; i += 1) during.push((await me(a, alice)).status);
    expect(during).toEqual(Array(USER_LIMIT).fill(200));
    expect(performance.now() - started).toBeLessThan(5000);

    // Still limited, by what this process has counted. Never unlimited.
    expect((await me(a, alice)).status).toBe(429);
    // The other instance has counted nothing of its own, so it allows its own four: the weakening an
    // outage costs, and the reason it is logged.
    expect((await me(b, alice)).status).toBe(200);

    await redis.start();

    // Redis comes back empty. Once the instances reconnect, a request on either spends from the shared
    // budget again: two requests on a fresh person, one on each, are counted together.
    const bob = users[1]!;
    let shared = false;
    for (let attempt = 0; attempt < 40 && !shared; attempt += 1) {
      await sleep(500);
      await me(a, bob);
      const raw = new Redis(redis.url);
      try {
        shared = (await raw.keys('crm:rl:v1:user:*')).length > 0;
      } finally {
        raw.disconnect();
      }
    }
    expect(shared).toBe(true);
  }, 120_000);
});
