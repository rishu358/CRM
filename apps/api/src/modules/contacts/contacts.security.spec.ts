import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot list/read/update/delete tenant B records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses and rejected on write
 *   (d) unauthenticated requests get 401
 *
 * They go through the real HTTP stack — the same guards, pipes, filter and
 * database roles as production — because every one of those layers is part of
 * what is being asserted.
 */

let harness: ApiHarness;

/** Tenant A: an admin with `all` scope and a rep with `own` scope. */
let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };

/** Tenant B: a separate company that must never be visible from tenant A. */
let tenantB: string;
let adminB: { token: string; userId: string };

let adminContactA: string;
let repContactA: string;
let contactB: string;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);

  const adminRoleA = rolesA.get('Admin')!;
  const repRoleA = rolesA.get('Sales Rep')!;
  const adminRoleB = rolesB.get('Admin')!;

  const admin = await harness.fixtures.createUser(tenantA, adminRoleA);
  adminA = { userId: admin.userId, token: await harness.signIn(admin.userId, tenantA) };

  const rep = await harness.fixtures.createUser(tenantA, repRoleA);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };

  const otherRep = await harness.fixtures.createUser(tenantA, repRoleA);
  otherRepA = { userId: otherRep.userId, token: await harness.signIn(otherRep.userId, tenantA) };

  const bAdmin = await harness.fixtures.createUser(tenantB, adminRoleB);
  adminB = { userId: bAdmin.userId, token: await harness.signIn(bAdmin.userId, tenantB) };

  adminContactA = await harness.fixtures.createContact(tenantA, {
    ownerId: adminA.userId,
    lastName: 'Mehta',
    email: 'mehta@acme.example',
  });
  repContactA = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Sharma',
    email: 'sharma@acme.example',
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
    email: 'rival@rival.example',
  });
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects a list with no credentials', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/contacts' });
    expect(response.status).toBe(401);
  });

  it('rejects a read, a create, an update and a delete', async () => {
    const calls = [
      { method: 'GET', url: `/api/v1/contacts/${adminContactA}` },
      { method: 'POST', url: '/api/v1/contacts', body: { lastName: 'Intruder' } },
      { method: 'PATCH', url: `/api/v1/contacts/${adminContactA}`, body: { version: 1 } },
      { method: 'DELETE', url: `/api/v1/contacts/${adminContactA}?version=1` },
    ] as const;

    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });

  it('returns the error envelope with a request id, and no stack trace', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/contacts' });
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(typeof error['requestId']).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:/);
  });

  it('still serves the health endpoint, which is explicitly public', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/health' });
    expect(response.status).toBe(200);
  });
});

describe('(a) tenant A cannot reach tenant B records', () => {
  it('lists only its own tenant records', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: adminA.token,
    });
    expect(response.status).toBe(200);

    const rows = response.body['data'] as { id: string }[];
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(adminContactA);
    expect(ids).toContain(repContactA);
    expect(ids).not.toContain(contactB);
  });

  it('returns 404 for another tenant record, not 403', async () => {
    // 403 would confirm the id exists, turning the endpoint into an oracle
    // for records in other companies (CLAUDE.md §5.5).
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${contactB}`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('gives the same 404 for an id that does not exist anywhere', async () => {
    const missing = '01a1443a-0000-7000-8000-000000000000';
    const absent = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${missing}`,
      token: adminA.token,
    });
    const foreign = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${contactB}`,
      token: adminA.token,
    });
    expect(absent.status).toBe(foreign.status);
    expect((absent.body['error'] as Record<string, unknown>)['message']).toBe(
      (foreign.body['error'] as Record<string, unknown>)['message'],
    );
  });

  it('cannot update another tenant record', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${contactB}`,
      token: adminA.token,
      body: { lastName: 'Hacked', version: 1 },
    });
    expect(response.status).toBe(404);

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${contactB}`,
      token: adminB.token,
    });
    expect((check.body['data'] as Record<string, unknown>)['lastName']).toBe('Rival');
  });

  it('cannot delete another tenant record', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/contacts/${contactB}?version=1`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
  });

  it('cannot switch tenant with a header for a tenant it does not belong to', async () => {
    // X-Tenant-Id is a request, not an authorization: membership decides.
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a created record name another tenant', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: adminA.token,
      body: { lastName: 'Smuggled', tenantId: tenantB },
    });
    // Rejected as an unknown key: tenant comes from the session, never the body.
    expect(response.status).toBe(422);
  });
});

describe('(b) a user with own scope cannot see other people records', () => {
  it('lists only the records the rep owns', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: repA.token,
    });
    expect(response.status).toBe(200);

    const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(repContactA);
    expect(ids).not.toContain(adminContactA);
  });

  it('returns 404 when the rep reads a colleague record by id', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${adminContactA}`,
      token: repA.token,
    });
    expect(response.status).toBe(404);
  });

  it('refuses the rep updating a colleague record', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${adminContactA}`,
      token: repA.token,
      body: { lastName: 'Taken', version: 1 },
    });
    expect(response.status).toBe(404);
  });

  it('refuses the rep deleting anything: Sales Rep has no delete grant', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/contacts/${repContactA}?version=1`,
      token: repA.token,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a rep assign a record to someone else', async () => {
    // Otherwise `own` scope could be used to push a record out of sight.
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: repA.token,
      body: { lastName: 'Handover', ownerId: otherRepA.userId },
    });
    expect(response.status).toBe(422);
  });

  it('assigns a rep own new records to themselves', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: repA.token,
      body: { lastName: 'Patel' },
    });
    expect(response.status).toBe(201);
    expect((response.body['data'] as Record<string, unknown>)['ownerId']).toBe(repA.userId);
  });

  it('lets an admin with all scope see every record in the tenant', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: adminA.token,
    });
    const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(adminContactA);
    expect(ids).toContain(repContactA);
  });
});

describe('(c) hidden fields are absent from responses and rejected on write', () => {
  let hiddenRepToken: string;
  let readOnlyFieldRepToken: string;
  let ownedContact: string;

  beforeAll(async () => {
    // A role that cannot see `phone` at all, and one that can read but not
    // write `lead_source`. Both are narrowings of a role that could otherwise
    // read and write everything.
    const hiddenRole = await harness.fixtures.createRole(tenantA, 'Rep without phone');
    await harness.fixtures.grantAll(tenantA, hiddenRole, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'contact', 'phone', 'hidden');

    const readOnlyRole = await harness.fixtures.createRole(tenantA, 'Rep with locked source');
    await harness.fixtures.grantAll(tenantA, readOnlyRole, 'contact', 'all');
    await harness.fixtures.setFieldPermission(
      tenantA,
      readOnlyRole,
      'contact',
      'lead_source',
      'read',
    );

    const hiddenUser = await harness.fixtures.createUser(tenantA, hiddenRole);
    hiddenRepToken = await harness.signIn(hiddenUser.userId, tenantA);

    const readOnlyUser = await harness.fixtures.createUser(tenantA, readOnlyRole);
    readOnlyFieldRepToken = await harness.signIn(readOnlyUser.userId, tenantA);

    ownedContact = await harness.fixtures.createContact(tenantA, {
      ownerId: hiddenUser.userId,
      lastName: 'Iyer',
      email: 'iyer@acme.example',
    });

    // Give the record a phone number to hide.
    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${ownedContact}`,
      token: adminA.token,
      body: { phone: '+919876500000', leadSource: 'referral', version: 1 },
    });
  });

  it('omits the hidden field from a single-record response', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${ownedContact}`,
      token: hiddenRepToken,
    });
    expect(response.status).toBe(200);

    const contact = response.body['data'] as Record<string, unknown>;
    // Absent, not null: a null would still confirm the field exists and is set.
    expect('phone' in contact).toBe(false);
    expect(contact['lastName']).toBe('Iyer');
  });

  it('omits the hidden field from every row of a list, not just the first', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: hiddenRepToken,
    });
    const rows = response.body['data'] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect('phone' in row).toBe(false);
    }
  });

  it('never leaks the hidden value anywhere in the payload', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: hiddenRepToken,
    });
    expect(JSON.stringify(response.body)).not.toContain('919876500000');
  });

  it('rejects a write to a hidden field instead of dropping it', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${ownedContact}`,
      token: hiddenRepToken,
      body: { phone: '+919000000000', version: 2 },
    });
    expect(response.status).toBe(403);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('FIELD_NOT_WRITABLE');

    // And the stored value is untouched.
    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${ownedContact}`,
      token: adminA.token,
    });
    expect((check.body['data'] as Record<string, unknown>)['phone']).toBe('+919876500000');
  });

  it('rejects a write to a read-only field', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${ownedContact}`,
      token: readOnlyFieldRepToken,
      body: { leadSource: 'website', version: 2 },
    });
    expect(response.status).toBe(403);
  });

  it('still shows a read-only field in responses', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${ownedContact}`,
      token: readOnlyFieldRepToken,
    });
    expect((response.body['data'] as Record<string, unknown>)['leadSource']).toBe('referral');
  });

  it('rejects a hidden field on create too, not only on update', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: hiddenRepToken,
      body: { lastName: 'Nair', phone: '+919000000001' },
    });
    expect(response.status).toBe(403);
  });
});
