import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10), for bulk actions and tags, and
 * the rule a bulk call adds: it must never be a way to do to many records what the caller could
 * not do to one, or to find out which records exist (ADR-0056).
 *
 *   (a) tenant A cannot edit, delete, assign or tag tenant B records, and does not learn they exist
 *   (b) a caller with `own` scope can only touch their own records; the report does not say
 *       whether a colleague's id exists
 *   (c) a field hidden from, or read-only for, a role can neither be changed in bulk nor used to
 *       choose the records
 *   (d) unauthenticated requests get 401
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let repA2: { token: string; userId: string };
let readerA: { token: string; userId: string };
let limitedA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

let repContact: string;
let repContact2: string;
let colleagueContact: string;
let adminContact: string;
let contactB: string;

interface Result {
  matched: number;
  changed: number;
  changedIds: string[];
  skipped: { id: string; reason: string; message?: string }[];
  nextCursor: string | null;
  replayed: boolean;
  dryRun: boolean;
}

const bulk = (token: string | undefined, body: unknown, headers?: Record<string, string>) =>
  request(harness, { method: 'POST', url: '/api/v1/bulk-actions', token, body, headers });

const ids = (...list: string[]) => ({ kind: 'ids' as const, ids: list });

const contactOf = async (token: string, id: string) =>
  request(harness, { method: 'GET', url: `/api/v1/contacts/${id}`, token });

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  const make = async (tenantId: string, roleId: string) => {
    const user = await harness.fixtures.createUser(tenantId, roleId);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };

  adminA = await make(tenantA, rolesA.get('Admin')!);
  repA = await make(tenantA, rolesA.get('Sales Rep')!);
  repA2 = await make(tenantA, rolesA.get('Sales Rep')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);

  // Sees every contact, may change only their own: "can see, may not touch".
  const readerRole = await harness.fixtures.createRole(tenantA, 'Reader');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'read', 'all');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'update', 'own');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'delete', 'own');
  readerA = await make(tenantA, readerRole);

  // May change contacts, but not see their email and not write their lead source.
  const limitedRole = await harness.fixtures.createRole(tenantA, 'Limited');
  await harness.fixtures.grantAll(tenantA, limitedRole, 'contact', 'all');
  await harness.fixtures.setFieldPermission(tenantA, limitedRole, 'contact', 'email', 'hidden');
  await harness.fixtures.setFieldPermission(
    tenantA,
    limitedRole,
    'contact',
    'lead_source',
    'hidden',
  );
  await harness.fixtures.setFieldPermission(tenantA, limitedRole, 'contact', 'title', 'read');
  limitedA = await make(tenantA, limitedRole);

  repContact = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Sharma',
    email: 'sharma@acme.example',
  });
  repContact2 = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Shah',
  });
  colleagueContact = await harness.fixtures.createContact(tenantA, {
    ownerId: repA2.userId,
    lastName: 'Iyer',
  });
  adminContact = await harness.fixtures.createContact(tenantA, {
    ownerId: adminA.userId,
    lastName: 'Mehta',
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
  });
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects a bulk action and the tag list with no credentials, or a made-up token', async () => {
    const body = { objectType: 'contact', action: 'delete', target: ids(repContact) };
    expect((await bulk(undefined, body)).status).toBe(401);
    expect((await bulk('not-a-real-session-token-but-long-enough', body)).status).toBe(401);
    expect((await request(harness, { method: 'GET', url: '/api/v1/tags' })).status).toBe(401);
    // Nothing happened.
    expect((await contactOf(adminA.token, repContact)).status).toBe(200);
  });
});

describe('(a) tenant A cannot reach tenant B records', () => {
  it('skips tenant B ids as not found, for every action, and changes nothing', async () => {
    const actions = [
      { action: 'edit', changes: { title: 'Pwned' } },
      { action: 'assign', ownerId: adminA.userId },
      { action: 'tag_add', tags: ['Intruder'] },
      { action: 'delete' },
    ];
    for (const action of actions) {
      const response = await bulk(adminA.token, {
        objectType: 'contact',
        target: ids(contactB),
        ...action,
      });
      const result = dataOf<Result>(response, 200);
      expect(result.changed, action.action).toBe(0);
      expect(result.skipped, action.action).toEqual([{ id: contactB, reason: 'not_found' }]);
    }

    const stillThere = dataOf<{ title?: string | null; ownerId?: string }>(
      await contactOf(adminB.token, contactB),
    );
    expect(stillThere.title ?? null).toBeNull();
    expect(stillThere.ownerId).toBe(adminB.userId);
  });

  it('answers a tenant B id exactly as it answers an id that does not exist', async () => {
    const real = dataOf<Result>(
      await bulk(adminA.token, { objectType: 'contact', action: 'delete', target: ids(contactB) }),
    );
    const invented = dataOf<Result>(
      await bulk(adminA.token, {
        objectType: 'contact',
        action: 'delete',
        target: ids('0197c3f0-0000-7000-8000-000000000000'),
      }),
    );
    expect(real.skipped[0]?.reason).toBe(invented.skipped[0]?.reason);
  });

  it('never matches tenant B records through a filter', async () => {
    const result = dataOf<Result>(
      await bulk(adminA.token, {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['Everyone'],
        target: { kind: 'filter', filter: { conditions: [] } },
      }),
    );
    expect(result.changedIds).not.toContain(contactB);
    expect(await harness.fixtures.recordTagNames(tenantB, 'contact', contactB)).toEqual([]);
  });

  it('does not show tenant B tags to tenant A', async () => {
    await bulk(adminB.token, {
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Rival secret tag'],
      target: ids(contactB),
    });
    const tags = dataOf<{ name: string }[]>(
      await request(harness, { method: 'GET', url: '/api/v1/tags', token: adminA.token }),
    );
    expect(tags.map((tag) => tag.name)).not.toContain('Rival secret tag');
  });
});

describe('(b) a caller with `own` scope can only touch their own records', () => {
  it('changes their own, and reports a colleague or admin record as not found', async () => {
    const response = await bulk(repA.token, {
      objectType: 'contact',
      action: 'edit',
      changes: { title: 'Director' },
      target: ids(repContact, colleagueContact, adminContact),
    });
    const result = dataOf<Result>(response, 200);
    expect(result.changedIds).toEqual([repContact]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { id: colleagueContact, reason: 'not_found' },
        { id: adminContact, reason: 'not_found' },
      ]),
    );
    expect(result.skipped).toHaveLength(2);

    // Untouched, as the people who own them see.
    expect(
      dataOf<{ title?: string | null }>(await contactOf(adminA.token, colleagueContact)).title ??
        null,
    ).toBeNull();
    expect(
      dataOf<{ title?: string | null }>(await contactOf(adminA.token, adminContact)).title ?? null,
    ).toBeNull();
  });

  it('answers a colleague id the way it answers one that does not exist', async () => {
    const colleague = dataOf<Result>(
      await bulk(repA.token, {
        objectType: 'contact',
        action: 'edit',
        changes: { title: 'Probe' },
        target: ids(colleagueContact),
      }),
    );
    const invented = dataOf<Result>(
      await bulk(repA.token, {
        objectType: 'contact',
        action: 'edit',
        changes: { title: 'Probe' },
        target: ids('0197c3f0-0000-7000-8000-000000000001'),
      }),
    );
    expect(colleague.skipped.map((s) => s.reason)).toEqual(invented.skipped.map((s) => s.reason));
    expect((await contactOf(adminA.token, colleagueContact)).status).toBe(200);
  });

  it('only matches their own records through a filter', async () => {
    const result = dataOf<Result>(
      await bulk(repA.token, {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['Mine'],
        target: { kind: 'filter', filter: { conditions: [] } },
      }),
    );
    expect(new Set(result.changedIds)).toEqual(new Set([repContact, repContact2]));
    expect(
      await harness.fixtures.recordTagNames(tenantA, 'contact', colleagueContact),
    ).not.toContain('Mine');
    expect(await harness.fixtures.recordTagNames(tenantA, 'contact', adminContact)).not.toContain(
      'Mine',
    );
  });

  it('refuses to hand records to somebody else: that needs `all` scope', async () => {
    const response = await bulk(repA.token, {
      objectType: 'contact',
      action: 'assign',
      ownerId: repA2.userId,
      target: ids(repContact2),
    });
    expect(response.status).toBe(422);
    const owner = dataOf<{ ownerId?: string }>(await contactOf(adminA.token, repContact2)).ownerId;
    expect(owner).toBe(repA.userId);
  });

  it('says `not_permitted`, not `not_found`, of a record the caller can see but may not change', async () => {
    const result = dataOf<Result>(
      await bulk(readerA.token, {
        objectType: 'contact',
        action: 'edit',
        changes: { title: 'Nope' },
        target: ids(colleagueContact),
      }),
    );
    expect(result.changed).toBe(0);
    expect(result.skipped).toEqual([{ id: colleagueContact, reason: 'not_permitted' }]);
  });

  it('is refused outright to a caller with no grant for the action at all', async () => {
    const role = await harness.fixtures.createRole(tenantA, 'Read only contacts');
    await harness.fixtures.grant(tenantA, role, 'contact', 'read', 'all');
    const user = await harness.fixtures.createUser(tenantA, role);
    const token = await harness.signIn(user.userId, tenantA);

    for (const action of [
      { action: 'edit', changes: { title: 'x' } },
      { action: 'delete' },
      { action: 'tag_add', tags: ['x'] },
      { action: 'assign', ownerId: adminA.userId },
    ]) {
      const response = await bulk(token, {
        objectType: 'contact',
        target: ids(repContact),
        ...action,
      });
      expect(response.status, action.action).toBe(403);
    }
  });
});

describe('(c) hidden and read-only fields', () => {
  it('refuses to change a field hidden from, or read-only for, the caller, and changes nothing', async () => {
    for (const changes of [{ lead_source: 'web' }, { title: 'Changed' }]) {
      const response = await bulk(limitedA.token, {
        objectType: 'contact',
        action: 'edit',
        changes,
        target: ids(adminContact),
      });
      expect(response.status).toBe(403);
      expect((response.body['error'] as { code: string }).code).toBe('FIELD_NOT_WRITABLE');
    }
    const after = dataOf<{ title?: string | null }>(await contactOf(adminA.token, adminContact));
    expect(after.title ?? null).toBeNull();
  });

  it('answers a field that does not exist exactly as a hidden one', async () => {
    const hidden = await bulk(limitedA.token, {
      objectType: 'contact',
      action: 'edit',
      changes: { lead_source: 'web' },
      target: ids(adminContact),
    });
    const missing = await bulk(limitedA.token, {
      objectType: 'contact',
      action: 'edit',
      changes: { no_such_field: 'web' },
      target: ids(adminContact),
    });
    expect(missing.status).toBe(hidden.status);
    const code = (r: { body: Record<string, unknown> }) =>
      (r.body['error'] as { code: string }).code;
    expect(code(missing)).toBe(code(hidden));
  });

  it('cannot choose records by a field the caller may not read', async () => {
    const response = await bulk(limitedA.token, {
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Probe'],
      target: {
        kind: 'filter',
        filter: { conditions: [{ field: 'email', operator: 'starts_with', value: 'sharma' }] },
      },
    });
    expect(response.status).toBe(422);
    expect(await harness.fixtures.recordTagNames(tenantA, 'contact', repContact)).not.toContain(
      'Probe',
    );
  });

  it('does not let a bulk edit change the fields a bulk edit is never allowed to', async () => {
    for (const key of ['email', 'owner_id', 'last_name', 'id', 'version']) {
      const response = await bulk(adminA.token, {
        objectType: 'contact',
        action: 'edit',
        changes: { [key]: key === 'owner_id' ? repA.userId : 'x@example.com' },
        target: ids(adminContact),
      });
      expect(response.status, key).toBeGreaterThanOrEqual(400);
    }
    const after = dataOf<{ lastName?: string; ownerId?: string }>(
      await contactOf(adminA.token, adminContact),
    );
    expect(after.lastName).toBe('Mehta');
    expect(after.ownerId).toBe(adminA.userId);
  });
});
