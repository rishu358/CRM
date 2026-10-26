import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Duplicate detection when a contact is added by hand (MVP_SPEC M4, ADR-0023, pilot finding F4).
 *
 * Before this, only a lead could be checked: 25 of 25 contacts created with an e-mail address that another
 * contact already held were saved with no word of it. The rules are the ones ADR-0023 sets for leads:
 * matches are offered, never imposed (the create still answers 201 and carries `meta.duplicates`), and a
 * match is held to the rules for reading that record, so it is not a way around them.
 *
 * The four mandatory suites (CLAUDE.md §10) for the new route, plus the rules this feature turns on.
 */
let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
let managerA: { token: string; userId: string };
let adminB: { token: string; userId: string };

const EMAIL = 'dup.person@dupco.example';
const PHONE = '+919800011122';

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
  tenantA = (await harness.fixtures.createTenant({ name: 'Dup Contacts A' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Dup Contacts B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await user(tenantA, rolesA.get('Admin')!);
  repA = await user(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = await user(tenantA, rolesA.get('Sales Rep')!);
  managerA = await user(tenantA, rolesA.get('Manager')!);
  adminB = await user(tenantB, rolesB.get('Admin')!);
}, 240_000);

afterAll(async () => {
  await harness.close();
});

const check = async (token: string | undefined, body: Record<string, unknown>) => {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/contacts/duplicate-check',
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
  request(harness, { method: 'POST', url: '/api/v1/contacts', token, body });

const duplicatesOf = (response: { body: Record<string, unknown> }): Match[] =>
  (response.body['meta'] as { duplicates?: Match[] } | undefined)?.duplicates ?? [];

describe('creating a contact reports the contacts it may duplicate', () => {
  it('still saves it (offered, never imposed) and says which contact it matches, on e-mail in any case', async () => {
    const first = await create(adminA.token, { lastName: 'First', email: EMAIL, phone: PHONE });
    expect(first.status).toBe(201);
    expect(duplicatesOf(first)).toEqual([]);
    const firstId = (first.body['data'] as { id: string }).id;

    const second = await create(adminA.token, {
      lastName: 'Second',
      email: EMAIL.toUpperCase(),
    });
    expect(second.status).toBe(201);
    expect(duplicatesOf(second)).toEqual([
      expect.objectContaining({ objectType: 'contact', id: firstId, matchedOn: ['email'] }),
    ]);
    const secondId = (second.body['data'] as { id: string }).id;
    // The new contact is never offered as a duplicate of itself.
    expect(duplicatesOf(second).map((match) => match.id)).not.toContain(secondId);
  });

  it('matches on phone, and says both reasons when both match', async () => {
    const response = await create(adminA.token, {
      lastName: 'Third',
      email: EMAIL,
      phone: PHONE,
    });
    expect(response.status).toBe(201);
    const reasons = duplicatesOf(response).map((match) => [...match.matchedOn].sort());
    expect(reasons).toContainEqual(['email', 'phone']);
  });

  it('says nothing when nothing matches, and when the new contact has no e-mail or phone', async () => {
    const unique = await create(adminA.token, {
      lastName: 'Unique',
      email: 'only.one@uniqueco.example',
    });
    expect(unique.status).toBe(201);
    expect(duplicatesOf(unique)).toEqual([]);

    const bare = await create(adminA.token, { lastName: 'Bare' });
    expect(bare.status).toBe(201);
    expect(duplicatesOf(bare)).toEqual([]);
  });

  it('is the same answer as the check made before saving', async () => {
    const before = await check(adminA.token, { email: EMAIL, phone: PHONE });
    expect(before.status).toBe(200);
    const ids = before.matches.map((match) => match.id).sort();

    const saved = await create(adminA.token, { lastName: 'Fourth', email: EMAIL, phone: PHONE });
    // The save reports what existed before it; the check ran before, so it cannot include the new one.
    expect(
      duplicatesOf(saved)
        .map((match) => match.id)
        .sort(),
    ).toEqual(ids);
  });
});

describe('(d) unauthenticated requests get 401', () => {
  it('refuses the check with no credentials, and with a made-up token', async () => {
    expect((await check(undefined, { email: EMAIL })).status).toBe(401);
    expect((await check('not-a-real-token', { email: EMAIL })).status).toBe(401);
  });
});

describe('(a) tenant isolation', () => {
  it('never offers another tenant’s contact, on e-mail or phone, in the check or on create', async () => {
    const rival = await harness.fixtures.createContact(tenantB, {
      ownerId: adminB.userId,
      lastName: 'RivalContact',
      email: 'shared@sharedco.example',
      phone: '+919800099001',
    });

    const probe = await check(adminA.token, {
      email: 'shared@sharedco.example',
      phone: '+919800099001',
    });
    expect(probe.status).toBe(200);
    expect(probe.matches).toEqual([]);
    expect(probe.raw).not.toContain(rival);
    expect(probe.raw).not.toContain('RivalContact');

    const saved = await create(adminA.token, {
      lastName: 'Lookalike',
      email: 'shared@sharedco.example',
      phone: '+919800099001',
    });
    expect(saved.status).toBe(201);
    expect(duplicatesOf(saved)).toEqual([]);
    expect(JSON.stringify(saved.body)).not.toContain(rival);
  });
});

describe('(b) record scope: a rep is told only about what they could open', () => {
  const COLLEAGUE_EMAIL = 'colleague.only@secretco.example';
  const COLLEAGUE_PHONE = '+919800099055';
  let colleagueContact: string;

  beforeAll(async () => {
    colleagueContact = await harness.fixtures.createContact(tenantA, {
      ownerId: otherRepA.userId,
      lastName: 'ColleagueContact',
      email: COLLEAGUE_EMAIL,
      phone: COLLEAGUE_PHONE,
    });
  });

  it('offers a colleague’s contact to the colleague, who may read it', async () => {
    const probe = await check(otherRepA.token, { email: COLLEAGUE_EMAIL, phone: COLLEAGUE_PHONE });
    expect(probe.matches.map((match) => match.id)).toContain(colleagueContact);
  });

  it('does not offer it to a rep on own scope, and answers as for a value nobody holds', async () => {
    const real = await check(repA.token, { email: COLLEAGUE_EMAIL, phone: COLLEAGUE_PHONE });
    expect(real.status).toBe(200);
    expect(real.matches).toEqual([]);
    expect(real.raw).not.toContain(colleagueContact);
    expect(real.raw).not.toContain('ColleagueContact');

    const imaginary = await check(repA.token, {
      email: 'nobody.at.all@nowhere.example',
      phone: '+919800099099',
    });
    expect(imaginary.status).toBe(real.status);
    expect(imaginary.matches).toEqual(real.matches);

    const saved = await create(repA.token, { lastName: 'Lookalike', email: COLLEAGUE_EMAIL });
    expect(saved.status).toBe(201);
    expect(duplicatesOf(saved)).toEqual([]);
  });

  it('offers it to a manager whose team scope reaches it, and to an admin', async () => {
    await harness.fixtures.createTeam(tenantA, 'Dup team', [managerA.userId, otherRepA.userId]);
    const asManager = await check(managerA.token, { email: COLLEAGUE_EMAIL });
    expect(asManager.matches.map((match) => match.id)).toContain(colleagueContact);
    const asAdmin = await check(adminA.token, { email: COLLEAGUE_EMAIL });
    expect(asAdmin.matches.map((match) => match.id)).toContain(colleagueContact);
  });
});

describe('(c) hidden fields', () => {
  it('does not match on a field the caller cannot read, and does not name the contact by it', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Contacts without phone or names');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'last_name', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'first_name', 'hidden');
    const blind = await user(tenantA, roleId);

    const phone = '+919800055566';
    await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      firstName: 'Concealed',
      lastName: 'Surname',
      email: 'labelled@label.example',
      phone,
    });

    // Typing the number learns nothing: otherwise this is a way to test guesses against a hidden field.
    expect((await check(blind.token, { phone })).matches).toEqual([]);
    expect((await check(adminA.token, { phone })).matches).toHaveLength(1);

    // A field they can read still matches, and the label shows only what they may read.
    const byEmail = await check(blind.token, { email: 'labelled@label.example' });
    expect(byEmail.matches).toHaveLength(1);
    expect(byEmail.matches[0]?.label).toBe('Contact');
    expect(byEmail.raw).not.toContain('Concealed');
    expect(byEmail.raw).not.toContain('Surname');
  });

  it('refuses to write a hidden field on create, as before', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Creates but phone hidden');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'own');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    const blind = await user(tenantA, roleId);
    const response = await create(blind.token, { lastName: 'Sneaky', phone: '+919800055577' });
    expect(response.status).toBe(403);
  });
});

describe('permission and input', () => {
  it('needs create on contacts: a role that can only read cannot use the check to browse', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Contact reader');
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    const reader = await user(tenantA, roleId);
    await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Browsed',
      email: 'browse.me@browse.example',
    });
    const response = await check(reader.token, { email: 'browse.me@browse.example' });
    expect(response.status).toBe(403);
    expect(response.raw).not.toContain('Browsed');
  });

  it('rejects unknown keys and a malformed phone with 422', async () => {
    expect((await check(adminA.token, { email: EMAIL, tenantId: tenantB })).status).toBe(422);
    expect((await check(adminA.token, { phone: '98765 43210' })).status).toBe(422);
  });

  it('an empty check matches nothing', async () => {
    const response = await check(adminA.token, {});
    expect(response.status).toBe(200);
    expect(response.matches).toEqual([]);
  });
});
