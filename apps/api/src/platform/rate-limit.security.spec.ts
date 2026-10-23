import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';

/**
 * Rate limits are per user and per tenant, not just per address (CLAUDE.md §5.14).
 *
 * The general limiter used to key on `request.actor`, which the guard sets only after the limiter has
 * already run, so in practice it keyed on the address: an office behind one NAT address shared one
 * budget, and one person on two addresses had two. These tests pin what the rule says.
 */
const USER_LIMIT = 5;

let harness: ApiHarness;
let tenantId: string;
let alice: string;
let bob: string;

const ONE = '203.0.113.10';
const TWO = '203.0.113.20';

const me = (token: string, remoteAddress: string) =>
  request(harness, { method: 'GET', url: '/api/v1/auth/me', token, remoteAddress });

async function statuses(token: string, remoteAddress: string, count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push((await me(token, remoteAddress)).status);
  return out;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'), {
    RATE_LIMIT_MAX_PER_USER: String(USER_LIMIT),
    RATE_LIMIT_WINDOW_SECONDS: '600',
  });
  tenantId = (await harness.fixtures.createTenant({ name: 'Rate limits' })).tenantId;
  const roles = await harness.provision(tenantId);
  const admin = roles.get('Admin')!;
  const a = await harness.fixtures.createUser(tenantId, admin);
  const b = await harness.fixtures.createUser(tenantId, admin);
  alice = await harness.signIn(a.userId, tenantId);
  bob = await harness.signIn(b.userId, tenantId);
});

afterAll(async () => {
  await harness.close();
});

describe('the general limit is per user', () => {
  it('does not make two people behind one address share a budget', async () => {
    // Alice spends hers entirely.
    expect(await statuses(alice, ONE, USER_LIMIT)).toEqual(Array(USER_LIMIT).fill(200));
    expect((await me(alice, ONE)).status).toBe(429);

    // Bob, at the same address, has not spent anything.
    expect(await statuses(bob, ONE, USER_LIMIT)).toEqual(Array(USER_LIMIT).fill(200));
  });

  it('does not let one person get a fresh budget by changing address', async () => {
    // Alice is already over her limit from the test above; a new address does not reset it.
    expect((await me(alice, TWO)).status).toBe(429);
  });
});

describe('a refused request', () => {
  it('is a 429 with a stable code and a Retry-After, not a 500', async () => {
    // Alice is over her limit by now.
    const refused = await me(alice, ONE);
    expect(refused.status).toBe(429);
    expect((refused.body['error'] as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('says nothing about the ceiling or what is left', async () => {
    const refused = await me(alice, ONE);
    const text = JSON.stringify(refused.body) + JSON.stringify(refused.headers);
    expect(text).not.toMatch(/x-ratelimit|remaining|limit of|\b5\b/i);
  });
});

describe('the per-address limit', () => {
  let limited: ApiHarness;
  const health = (remoteAddress: string) =>
    request(limited, { method: 'GET', url: '/api/v1/health', remoteAddress });

  beforeAll(async () => {
    limited = await startApiHarness(inject('dbUrls'), {
      RATE_LIMIT_MAX_PER_IP: '3',
      RATE_LIMIT_MAX_PER_USER: '100000',
      RATE_LIMIT_WINDOW_SECONDS: '600',
    });
  });

  afterAll(async () => {
    await limited.close();
  });

  it('bounds what one address can send before it has signed in, and not another address', async () => {
    const first: number[] = [];
    for (let i = 0; i < 4; i += 1) first.push((await health(ONE)).status);
    expect(first).toEqual([200, 200, 200, 429]);
    expect((await health(TWO)).status).toBe(200);
  });
});
