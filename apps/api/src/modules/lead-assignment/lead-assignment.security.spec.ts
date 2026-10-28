import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for the lead assignment rules
 * (ADR-0065 10), through the real HTTP stack:
 *
 *   (a) tenant A cannot see, change or delete B's rules, name B's people or teams in its own, or
 *       learn anything of B by testing a sample lead
 *   (b) only the `lead_assignment` grant manages rules; each action is its own grant
 *   (c) nothing that is not the company's own rule is in an answer, and a write cannot name a
 *       company, an author or a place in the order by any other road
 *   (d) unauthenticated requests get 401
 */

interface Person {
  token: string;
  userId: string;
}
interface Overview {
  rules: { id: string; name: string; version: number }[];
  people: { id: string; name: string }[];
  teams: { id: string }[];
}

let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let adminB: Person;
let repA: Person;
let readerA: Person;
let creatorA: Person;
let teamB: string;
let ruleB: { id: string; version: number };

const MISSING = '0198f0f0-0000-7000-8000-000000000000';

async function person(tenantId: string, roleId: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

const as = (
  who: Person | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    ...(who === null ? {} : { token: who.token }),
    ...(body === undefined ? {} : { body }),
  });

async function customRole(
  tenantId: string,
  name: string,
  grants: [string, 'read' | 'create' | 'update' | 'delete', 'own' | 'team' | 'all'][],
): Promise<Person> {
  const roleId = await harness.fixtures.createRole(tenantId, name);
  for (const [objectType, action, scope] of grants) {
    await harness.fixtures.grant(tenantId, roleId, objectType, action, scope);
  }
  return person(tenantId, roleId);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Rules' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Rules' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await person(tenantA, rolesA.get('Admin')!);
  repA = await person(tenantA, rolesA.get('Sales Rep')!);
  adminB = await person(tenantB, rolesB.get('Admin')!);
  readerA = await customRole(tenantA, 'Rules reader', [['lead_assignment', 'read', 'all']]);
  creatorA = await customRole(tenantA, 'Rules creator', [
    ['lead_assignment', 'read', 'all'],
    ['lead_assignment', 'create', 'all'],
  ]);
  teamB = await harness.fixtures.createTeam(tenantB, 'Rival closers', [adminB.userId]);

  const made = dataOf<Overview>(
    await as(adminB, 'POST', '/lead-assignment/rules', {
      name: 'Rival secret rule',
      action: { type: 'user', userId: adminB.userId },
    }),
    201,
  );
  ruleB = made.rules[0]!;
});

afterAll(async () => {
  await harness.close();
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('does not show B’s rules, people or teams', async () => {
    const view = dataOf<Overview>(await as(adminA, 'GET', '/lead-assignment'), 200);
    expect(JSON.stringify(view)).not.toContain('Rival');
    expect(view.rules.some((rule) => rule.id === ruleB.id)).toBe(false);
    expect(view.people.some((entry) => entry.id === adminB.userId)).toBe(false);
    expect(view.teams.some((team) => team.id === teamB)).toBe(false);
  });

  it.each([
    ['edits', 'PATCH'],
    ['deletes', 'DELETE'],
  ] as const)('answers 404 when A %s B’s rule', async (_label, method) => {
    const response =
      method === 'PATCH'
        ? await as(adminA, 'PATCH', `/lead-assignment/rules/${ruleB.id}`, {
            name: 'Hijacked',
            version: ruleB.version,
          })
        : await as(adminA, 'DELETE', `/lead-assignment/rules/${ruleB.id}?version=${ruleB.version}`);
    expect(response.status).toBe(404);
    const still = dataOf<Overview>(await as(adminB, 'GET', '/lead-assignment'), 200);
    expect(still.rules.map((rule) => rule.name)).toEqual(['Rival secret rule']);
  });

  it('refuses a rule of A that names B’s person or B’s team', async () => {
    const person = await as(adminA, 'POST', '/lead-assignment/rules', {
      name: 'Steal',
      action: { type: 'user', userId: adminB.userId },
    });
    expect(person.status).toBe(422);
    const team = await as(adminA, 'POST', '/lead-assignment/rules', {
      name: 'Steal team',
      action: { type: 'team_round_robin', teamId: teamB },
    });
    expect(team.status).toBe(422);
    const settings = await as(adminA, 'PATCH', '/lead-assignment/settings', {
      defaultOwnerId: adminB.userId,
      version: 1,
    });
    expect(settings.status).toBe(422);
  });

  it('cannot reorder across companies: an order naming B’s rule is refused', async () => {
    const mine = dataOf<Overview>(
      await as(adminA, 'POST', '/lead-assignment/rules', {
        name: 'Mine',
        action: { type: 'default_owner' },
      }),
      201,
    );
    const response = await as(adminA, 'POST', '/lead-assignment/rules/order', {
      ruleIds: [mine.rules[0]!.id, ruleB.id],
    });
    expect(response.status).toBe(409);
  });

  it('a test of a sample lead never names B’s people', async () => {
    const answer = await as(adminA, 'POST', '/lead-assignment/test', { fields: { city: 'Pune' } });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain(adminB.userId);
  });
});

describe('(b) only the lead_assignment grant manages rules', () => {
  it('refuses a sales rep every route with 403', async () => {
    for (const [method, url, body] of [
      ['GET', '/lead-assignment', undefined],
      ['POST', '/lead-assignment/rules', { name: 'x', action: { type: 'default_owner' } }],
      ['POST', '/lead-assignment/rules/order', { ruleIds: [MISSING] }],
      ['PATCH', `/lead-assignment/rules/${MISSING}`, { name: 'x', version: 1 }],
      ['DELETE', `/lead-assignment/rules/${MISSING}?version=1`, undefined],
      ['PATCH', '/lead-assignment/settings', { defaultOwnerId: null, version: 1 }],
      ['POST', '/lead-assignment/test', { fields: {} }],
    ] as const) {
      expect((await as(repA, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
  });

  it('makes each action its own grant', async () => {
    expect((await as(readerA, 'GET', '/lead-assignment')).status).toBe(200);
    expect((await as(readerA, 'POST', '/lead-assignment/test', { fields: {} })).status).toBe(200);
    for (const [method, url, body] of [
      ['POST', '/lead-assignment/rules', { name: 'x', action: { type: 'default_owner' } }],
      ['POST', '/lead-assignment/rules/order', { ruleIds: [MISSING] }],
      ['PATCH', '/lead-assignment/settings', { defaultOwnerId: null, version: 1 }],
      ['DELETE', `/lead-assignment/rules/${MISSING}?version=1`, undefined],
    ] as const) {
      expect((await as(readerA, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
    const created = await as(creatorA, 'POST', '/lead-assignment/rules', {
      name: 'Made by a creator',
      action: { type: 'default_owner' },
    });
    expect(created.status).toBe(201);
    const made = (created.body['data'] as Overview).rules[0]!;
    expect(
      (
        await as(creatorA, 'PATCH', `/lead-assignment/rules/${made.id}`, {
          name: 'y',
          version: made.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (await as(creatorA, 'DELETE', `/lead-assignment/rules/${made.id}?version=${made.version}`))
        .status,
    ).toBe(403);
  });

  it('is not implied by the lead or web form grants', async () => {
    const boss = await customRole(tenantA, 'Lead and form boss', [
      ['lead', 'read', 'all'],
      ['lead', 'update', 'all'],
      ['lead_form', 'read', 'all'],
      ['lead_form', 'create', 'all'],
      ['lead_form', 'update', 'all'],
      ['lead_form', 'delete', 'all'],
    ]);
    expect((await as(boss, 'GET', '/lead-assignment')).status).toBe(403);
  });
});

describe('(c) nothing else gets in or out', () => {
  it('rejects a write that names a company, an author, a place or a pointer', async () => {
    for (const extra of [
      { tenantId: tenantB },
      { createdBy: adminB.userId },
      { position: 1 },
      { lastUserId: adminB.userId },
      { version: 99 },
    ]) {
      const response = await as(adminA, 'POST', '/lead-assignment/rules', {
        name: 'Forged',
        action: { type: 'default_owner' },
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('answers with names and ids of people who work for the company, and no address or password', async () => {
    const text = JSON.stringify(await as(adminA, 'GET', '/lead-assignment'));
    expect(text).not.toMatch(/@example\.com|password|hash|session/i);
  });
});

describe('(d) unauthenticated requests get 401', () => {
  it.each([
    ['GET', '/lead-assignment'],
    ['POST', '/lead-assignment/rules'],
    ['POST', '/lead-assignment/rules/order'],
    ['PATCH', `/lead-assignment/rules/${MISSING}`],
    ['DELETE', `/lead-assignment/rules/${MISSING}?version=1`],
    ['PATCH', '/lead-assignment/settings'],
    ['POST', '/lead-assignment/test'],
  ] as const)('%s %s', async (method, url) => {
    const response = await as(
      null,
      method,
      url,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(response.status).toBe(401);
  });
});
