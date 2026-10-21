import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10) for customization
 * (MVP_SPEC M9, ADR-0039), with the shape of this module in mind. A definition is
 * not a record — there is no owner and so no `own` scope — but it decides what every
 * record in the company looks like, which makes who may change it, and whose it is,
 * the whole question:
 *
 *   (a) tenant A cannot list, read or change tenant B's definitions
 *   (b) only `tenant_settings:update` can change anything; reading needs `read` on the object
 *   (c) a field hidden from a role is absent from that role's list, and unwritable
 *   (d) unauthenticated requests get 401
 *
 * Through the real HTTP stack, with the production guards, pipes and database roles.
 */

interface Person {
  token: string;
  userId: string;
}
interface Definition {
  id: string;
  key: string;
  label: string;
  isActive: boolean;
  version: number;
}

let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let repA: Person;
let readOnlyA: Person;
let adminB: Person;
let fieldA: Definition;
let fieldB: Definition;

async function person(tenantId: string, roleId: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

const asUser = (
  who: Person | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
) =>
  request(harness, {
    method,
    url,
    ...(who === null ? {} : { token: who.token }),
    ...(body === undefined ? {} : { body }),
  });

async function makeField(who: Person, objectType: string, label: string): Promise<Definition> {
  return dataOf<Definition>(
    await asUser(who, 'POST', '/api/v1/fields', { objectType, label, type: 'text' }),
    201,
  );
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Custom' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Custom' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await person(tenantA, rolesA.get('Admin')!);
  repA = await person(tenantA, rolesA.get('Sales Rep')!);
  readOnlyA = await person(tenantA, rolesA.get('Read-only')!);
  adminB = await person(tenantB, rolesB.get('Admin')!);

  fieldA = await makeField(adminA, 'contact', 'Acme secret handshake');
  fieldB = await makeField(adminB, 'contact', 'Rival secret handshake');
});

afterAll(async () => {
  await harness.close();
});

const ENDPOINTS = [
  ['GET', '/api/v1/fields?objectType=contact'],
  ['POST', '/api/v1/fields'],
  ['PATCH', '/api/v1/fields/0198f0f0-0000-7000-8000-000000000000'],
  ['POST', '/api/v1/fields/order'],
] as const;

describe('(d) unauthenticated requests get 401', () => {
  it.each(ENDPOINTS)('rejects %s %s with no credentials', async (method, url) => {
    const response = await asUser(null, method, url, method === 'GET' ? undefined : {});
    expect(response.status).toBe(401);
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/fields?objectType=contact',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });
});

describe('(a) tenant isolation', () => {
  it("never lists the other company's definitions, in either direction", async () => {
    const a = JSON.stringify(
      await asUser(adminA, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
    );
    const b = JSON.stringify(
      await asUser(adminB, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
    );
    expect(a).toContain('Acme secret handshake');
    expect(a).not.toContain('Rival secret handshake');
    expect(b).toContain('Rival secret handshake');
    expect(b).not.toContain('Acme secret handshake');
  });

  it("answers 404 for another company's field, as for one that does not exist", async () => {
    const foreign = await asUser(adminA, 'PATCH', `/api/v1/fields/${fieldB.id}`, {
      version: fieldB.version,
      label: 'Hijacked',
    });
    const missing = await asUser(
      adminA,
      'PATCH',
      '/api/v1/fields/0198f0f0-0000-7000-8000-000000000000',
      { version: 1, label: 'Hijacked' },
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual({
      error: expect.objectContaining({
        code: 'NOT_FOUND',
        message: (missing.body['error'] as Record<string, unknown>)['message'],
      }),
    });

    const theirs = dataOf<Definition[]>(
      await asUser(adminB, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
      200,
    );
    expect(theirs.find((f) => f.id === fieldB.id)?.label).toBe('Rival secret handshake');
  });

  it("cannot order, or be ordered by, the other company's fields", async () => {
    const response = await asUser(adminA, 'POST', '/api/v1/fields/order', {
      objectType: 'contact',
      ids: [fieldA.id, fieldB.id],
    });
    expect(response.status).toBe(422);
    const own = await asUser(adminB, 'POST', '/api/v1/fields/order', {
      objectType: 'contact',
      ids: [fieldB.id],
    });
    expect(own.status).toBe(200);
  });

  it('lets two companies use the same label for the same key without either knowing', async () => {
    const a = await makeField(adminA, 'lead', 'Shared label');
    const b = await makeField(adminB, 'lead', 'Shared label');
    expect(a.key).toBe('shared_label');
    expect(b.key).toBe('shared_label');
  });

  it('ignores a company named in a header or a body: the session decides', async () => {
    const header = await request(harness, {
      method: 'GET',
      url: '/api/v1/fields?objectType=contact&includeInactive=true',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect(JSON.stringify(header.body)).not.toContain('Rival secret handshake');

    const body = await asUser(adminA, 'POST', '/api/v1/fields', {
      objectType: 'contact',
      label: 'Planted',
      type: 'text',
      tenantId: tenantB,
    });
    expect(body.status).toBe(422);
  });
});

describe('(b) who may do what', () => {
  it('lets a rep read the definitions of an object they can read, and nothing more', async () => {
    const response = await asUser(repA, 'GET', '/api/v1/fields?objectType=contact');
    expect(response.status).toBe(200);
    const fields = dataOf<Definition[]>(response, 200);
    expect(fields.some((f) => f.id === fieldA.id)).toBe(true);
  });

  it.each([
    ['rep', () => repA],
    ['read-only user', () => readOnlyA],
  ])('refuses the management list, and every write, to a %s', async (_name, who) => {
    const person = who();
    const calls = [
      await asUser(person, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
      await asUser(person, 'POST', '/api/v1/fields', {
        objectType: 'contact',
        label: 'Sneaky',
        type: 'text',
      }),
      await asUser(person, 'PATCH', `/api/v1/fields/${fieldA.id}`, {
        version: fieldA.version,
        isActive: false,
      }),
      await asUser(person, 'POST', '/api/v1/fields/order', {
        objectType: 'contact',
        ids: [fieldA.id],
      }),
    ];
    for (const response of calls) expect(response.status).toBe(403);

    // And nothing happened.
    const now = dataOf<Definition[]>(
      await asUser(adminA, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
      200,
    );
    expect(now.find((f) => f.id === fieldA.id)).toMatchObject({ isActive: true, version: 1 });
    expect(now.some((f) => f.label === 'Sneaky')).toBe(false);
  });

  it('refuses the list of an object the caller cannot read, even to name its fields', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Leads only');
    await harness.fixtures.grantAll(tenantA, roleId, 'lead', 'all');
    const who = await person(tenantA, roleId);
    expect((await asUser(who, 'GET', '/api/v1/fields?objectType=contact')).status).toBe(403);
    expect((await asUser(who, 'GET', '/api/v1/fields?objectType=lead')).status).toBe(200);
  });

  it('is the tenant_settings grant that lets a role customise, and nothing else', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Customiser');
    await harness.fixtures.grant(tenantA, roleId, 'tenant_settings', 'update', 'all');
    const who = await person(tenantA, roleId);

    // May change, though not list the object's fields (that needs `read` on it).
    const made = await asUser(who, 'POST', '/api/v1/fields', {
      objectType: 'account',
      label: 'By a customiser',
      type: 'text',
    });
    expect(made.status).toBe(201);
    expect((await asUser(who, 'GET', '/api/v1/fields?objectType=account')).status).toBe(403);
  });

  it('does not take the right from a role that can only read settings', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Settings reader');
    await harness.fixtures.grant(tenantA, roleId, 'tenant_settings', 'read', 'all');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    const who = await person(tenantA, roleId);
    expect(
      (await asUser(who, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true')).status,
    ).toBe(200);
    expect(
      (
        await asUser(who, 'POST', '/api/v1/fields', {
          objectType: 'contact',
          label: 'No',
          type: 'text',
        })
      ).status,
    ).toBe(403);
  });
});

describe('(c) a hidden field is absent from the list, and unwritable', () => {
  it('leaves a field out of the form list for a role that cannot read it, but not out of management', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'No handshake');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', fieldA.key, 'hidden');
    const who = await person(tenantA, roleId);

    const forForms = JSON.stringify(await asUser(who, 'GET', '/api/v1/fields?objectType=contact'));
    expect(forForms).not.toContain('Acme secret handshake');
    expect(forForms).not.toContain(fieldA.key);

    // The same role, asking for the management view, is refused rather than shown it.
    expect(
      (await asUser(who, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true')).status,
    ).toBe(403);

    // An administrator, whose job it is, still sees it.
    const admin = JSON.stringify(
      await asUser(adminA, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
    );
    expect(admin).toContain('Acme secret handshake');
  });

  it('keeps the form list to what the administrator can read too: a form is for filling in', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Admin without handshake');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.grant(tenantA, roleId, 'tenant_settings', 'read', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', fieldA.key, 'hidden');
    const who = await person(tenantA, roleId);
    const list = JSON.stringify(await asUser(who, 'GET', '/api/v1/fields?objectType=contact'));
    expect(list).not.toContain(fieldA.key);

    // Their management view is about the company's configuration, not its data, so the
    // same person sees every definition there, the hidden one included.
    const managed = JSON.stringify(
      await asUser(who, 'GET', '/api/v1/fields?objectType=contact&includeInactive=true'),
    );
    expect(managed).toContain(fieldA.key);
  });

  it('says which fields the caller may write, so a form offers a box only where it can work', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Reader of handshake');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', fieldA.key, 'read');
    const who = await person(tenantA, roleId);

    const writableFor = async (person: Person) => {
      const fields = dataOf<(Definition & { writable: boolean })[]>(
        await asUser(person, 'GET', '/api/v1/fields?objectType=contact'),
        200,
      );
      return fields.find((f) => f.id === fieldA.id)?.writable;
    };
    expect(await writableFor(who)).toBe(false);
    expect(await writableFor(adminA)).toBe(true);
  });

  it('refuses a write to the hidden field on a record, without saying that it exists', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Writer without handshake');
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', fieldA.key, 'hidden');
    const who = await person(tenantA, roleId);

    const hidden = await asUser(who, 'POST', '/api/v1/contacts', {
      lastName: 'Hidden write',
      customFields: { [fieldA.key]: 'x' },
    });
    const unknown = await asUser(who, 'POST', '/api/v1/contacts', {
      lastName: 'Unknown write',
      customFields: { no_such_field: 'x' },
    });
    expect(hidden.status).toBe(unknown.status);
    expect(hidden.status).toBe(403);
  });
});

describe('what the API will not take', () => {
  it.each([
    ['isSystem on create', { isSystem: true }],
    ['a key on create', { key: 'chosen' }],
    ['a position on create', { position: 1 }],
    ['an owner on create', { ownerId: '0198f0f0-0000-7000-8000-000000000000' }],
    ['a pattern on create', { validation: { pattern: '(a+)+$' } }],
    ['a user_lookup type', { type: 'user_lookup' }],
    ['a made-up type', { type: 'formula' }],
    ['an object that is not customisable', { objectType: 'activity' }],
  ])('rejects %s', async (_name, extra) => {
    const response = await asUser(adminA, 'POST', '/api/v1/fields', {
      objectType: 'contact',
      label: 'Rejected',
      type: 'text',
      ...extra,
    });
    expect(response.status).toBe(422);
  });

  it('rejects a label that is empty, blank or too long', async () => {
    for (const label of ['', '   ', 'x'.repeat(81)]) {
      const response = await asUser(adminA, 'POST', '/api/v1/fields', {
        objectType: 'contact',
        label,
        type: 'text',
      });
      expect(response.status, JSON.stringify(label)).toBe(422);
    }
  });

  it('turns the 61st field, however it is sent, into a refusal and not an error', async () => {
    const t = (await harness.fixtures.createTenant({ name: 'Full Co' })).tenantId;
    const roles = await harness.provision(t);
    const admin = await person(t, roles.get('Admin')!);
    for (let n = 0; n < 60; n += 1) {
      await harness.fixtures.createFieldDefinition(t, {
        objectType: 'account',
        key: `f${n}`,
        type: 'text',
      });
    }
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        asUser(admin, 'POST', '/api/v1/fields', {
          objectType: 'account',
          label: `Extra ${n}`,
          type: 'text',
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([422, 422, 422]);
  }, 60_000);
});
