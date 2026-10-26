import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Duplicate detection when an account is added by hand (MVP_SPEC M4, ADR-0023, pilot finding F4).
 *
 * Matches are offered, never imposed (the create still answers 201 and carries `meta.duplicates`), on the
 * same domain or a name that is close, and a match is held to the rules for reading that account.
 * The four mandatory suites (CLAUDE.md §10) for the new route, plus the rules this feature turns on.
 */
let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
let adminB: { token: string; userId: string };

interface Match {
  objectType: string;
  id: string;
  label: string;
  matchedOn: string[];
}

async function user(tenantId: string, roleId: string) {
  const created = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantA = (await harness.fixtures.createTenant({ name: 'Dup Accounts A' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Dup Accounts B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await user(tenantA, rolesA.get('Admin')!);
  repA = await user(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = await user(tenantA, rolesA.get('Sales Rep')!);
  adminB = await user(tenantB, rolesB.get('Admin')!);
}, 240_000);

afterAll(async () => {
  await harness.close();
});

const check = async (token: string | undefined, body: Record<string, unknown>) => {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/accounts/duplicate-check',
    token,
    body,
  });
  return {
    status: response.status,
    matches: (response.body['data'] as Match[] | undefined) ?? [],
    raw: JSON.stringify(response.body),
  };
};

const create = (token: string, body: Record<string, unknown>) =>
  request(harness, { method: 'POST', url: '/api/v1/accounts', token, body });

const duplicatesOf = (response: { body: Record<string, unknown> }): Match[] =>
  (response.body['meta'] as { duplicates?: Match[] } | undefined)?.duplicates ?? [];

describe('creating an account reports the accounts it may duplicate', () => {
  it('still saves it, and says which account it matches on domain, in any case', async () => {
    const first = await create(adminA.token, {
      name: 'Lotus Design Studio',
      domain: 'lotus.example',
    });
    expect(first.status).toBe(201);
    expect(duplicatesOf(first)).toEqual([]);
    const firstId = (first.body['data'] as { id: string }).id;

    const second = await create(adminA.token, { name: 'Quite Different', domain: 'LOTUS.example' });
    expect(second.status).toBe(201);
    expect(duplicatesOf(second)).toEqual([
      expect.objectContaining({ objectType: 'account', id: firstId, matchedOn: ['domain'] }),
    ]);
    const secondId = (second.body['data'] as { id: string }).id;
    expect(duplicatesOf(second).map((match) => match.id)).not.toContain(secondId);
  });

  it('matches on a close name (pg_trgm, 0.5) and says so', async () => {
    const response = await create(adminA.token, { name: 'Lotus Design Studios' });
    expect(response.status).toBe(201);
    expect(duplicatesOf(response).map((match) => match.matchedOn)).toContainEqual(['name']);
  });

  it('does not match a name that only shares one word', async () => {
    await create(adminA.token, { name: 'Acme Trading' });
    const response = await create(adminA.token, { name: 'Zenith Trading' });
    expect(response.status).toBe(201);
    expect(duplicatesOf(response)).toEqual([]);
  });

  it('is the same answer as the check made before saving', async () => {
    const before = await check(adminA.token, {
      name: 'Lotus Design Studio',
      domain: 'lotus.example',
    });
    expect(before.status).toBe(200);
    expect(before.matches.length).toBeGreaterThan(0);
    const saved = await create(adminA.token, {
      name: 'Lotus Design Studio',
      domain: 'lotus.example',
    });
    expect(
      duplicatesOf(saved)
        .map((match) => match.id)
        .sort(),
    ).toEqual(before.matches.map((match) => match.id).sort());
  });
});

describe('(d) unauthenticated requests get 401', () => {
  it('refuses the check with no credentials, and with a made-up token', async () => {
    expect((await check(undefined, { name: 'Acme' })).status).toBe(401);
    expect((await check('not-a-real-token', { name: 'Acme' })).status).toBe(401);
  });
});

describe('(a) tenant isolation', () => {
  it('never offers another tenant’s account, on domain or name, in the check or on create', async () => {
    const rival = await harness.fixtures.createAccount(tenantB, {
      ownerId: adminB.userId,
      name: 'Sharedco Industries',
      domain: 'sharedco.example',
    });

    const probe = await check(adminA.token, {
      name: 'Sharedco Industries',
      domain: 'sharedco.example',
    });
    expect(probe.status).toBe(200);
    expect(probe.matches).toEqual([]);
    expect(probe.raw).not.toContain(rival);

    const saved = await create(adminA.token, {
      name: 'Sharedco Industries',
      domain: 'sharedco.example',
    });
    expect(saved.status).toBe(201);
    expect(duplicatesOf(saved)).toEqual([]);
  });
});

describe('(b) record scope: a rep is told only about what they could open', () => {
  let colleagueAccount: string;

  beforeAll(async () => {
    colleagueAccount = await harness.fixtures.createAccount(tenantA, {
      ownerId: otherRepA.userId,
      name: 'Secretco Holdings',
      domain: 'secretco.example',
    });
  });

  it('offers a colleague’s account to the colleague', async () => {
    const probe = await check(otherRepA.token, {
      name: 'Secretco Holdings',
      domain: 'secretco.example',
    });
    expect(probe.matches.map((match) => match.id)).toContain(colleagueAccount);
  });

  it('does not offer it to a rep on own scope, and answers as for a name nobody holds', async () => {
    const real = await check(repA.token, { name: 'Secretco Holdings', domain: 'secretco.example' });
    expect(real.status).toBe(200);
    expect(real.matches).toEqual([]);
    expect(real.raw).not.toContain(colleagueAccount);
    expect(real.raw).not.toContain('Secretco');

    const imaginary = await check(repA.token, {
      name: 'Nobody Anywhere Ltd',
      domain: 'nowhere.example',
    });
    expect(imaginary.status).toBe(real.status);
    expect(imaginary.matches).toEqual(real.matches);

    const saved = await create(repA.token, {
      name: 'Secretco Holdings',
      domain: 'secretco.example',
    });
    expect(saved.status).toBe(201);
    expect(duplicatesOf(saved)).toEqual([]);
  });

  it('offers it to an admin', async () => {
    const probe = await check(adminA.token, { domain: 'secretco.example' });
    expect(probe.matches.map((match) => match.id)).toContain(colleagueAccount);
  });
});

describe('(c) hidden fields', () => {
  it('does not match on a field the caller cannot read, and the label shows only what they may read', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Accounts without domain or name');
    await harness.fixtures.grantAll(tenantA, roleId, 'account', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'account', 'domain', 'hidden');
    const noDomain = await user(tenantA, roleId);

    await harness.fixtures.createAccount(tenantA, {
      ownerId: adminA.userId,
      name: 'Hidden Domain Traders',
      domain: 'hiddendomain.example',
    });

    // Typing the domain learns nothing: it would be a way to test guesses against a hidden field.
    expect((await check(noDomain.token, { domain: 'hiddendomain.example' })).matches).toEqual([]);
    expect((await check(adminA.token, { domain: 'hiddendomain.example' })).matches).toHaveLength(1);
    // The name is readable for them, so a name match still works.
    expect(
      (await check(noDomain.token, { name: 'Hidden Domain Traders' })).matches.length,
    ).toBeGreaterThan(0);

    const nameRole = await harness.fixtures.createRole(tenantA, 'Accounts without name');
    await harness.fixtures.grantAll(tenantA, nameRole, 'account', 'all');
    await harness.fixtures.setFieldPermission(tenantA, nameRole, 'account', 'name', 'hidden');
    const noName = await user(tenantA, nameRole);
    const byDomain = await check(noName.token, { domain: 'hiddendomain.example' });
    expect(byDomain.matches).toHaveLength(1);
    expect(byDomain.matches[0]?.label).toBe('Account');
    expect(byDomain.raw).not.toContain('Hidden Domain Traders');
  });
});

describe('permission and input', () => {
  it('needs create on accounts: a role that can only read cannot use the check to browse', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Account reader');
    await harness.fixtures.grant(tenantA, roleId, 'account', 'read', 'all');
    const reader = await user(tenantA, roleId);
    await harness.fixtures.createAccount(tenantA, {
      ownerId: adminA.userId,
      name: 'Browsed Brothers',
      domain: 'browsed.example',
    });
    const response = await check(reader.token, { domain: 'browsed.example' });
    expect(response.status).toBe(403);
    expect(response.raw).not.toContain('Browsed');
  });

  it('rejects unknown keys and a malformed domain with 422', async () => {
    expect((await check(adminA.token, { name: 'Acme', tenantId: tenantB })).status).toBe(422);
    expect((await check(adminA.token, { domain: 'not a domain' })).status).toBe(422);
  });

  it('an empty check matches nothing', async () => {
    const response = await check(adminA.token, {});
    expect(response.status).toBe(200);
    expect(response.matches).toEqual([]);
  });
});
