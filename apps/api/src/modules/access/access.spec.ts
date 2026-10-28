import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Behaviour of roles, members, teams, ownership and the effect preview
 * (MVP_SPEC M3). The security properties are in `access.security.spec.ts`; this
 * file is about the feature doing what an administrator expects, with the one
 * eye that matters most kept open: **the preview says what the save then does**.
 */
let harness: ApiHarness;
let tenantId: string;
let roles: ReadonlyMap<string, string>;

interface Person {
  userId: string;
  token: string;
}
let admin: Person;
let rahul: Person; // Manager, North
let meera: Person; // Manager, South
let priya: Person; // Sales Rep, North
let bhavin: Person; // Sales Rep, South

async function person(roleId: string, name: string): Promise<Person> {
  const created = await harness.fixtures.createUser(tenantId, roleId, { name });
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

async function contacts(owner: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      await harness.fixtures.createContact(tenantId, { ownerId: owner, lastName: `N${index}` }),
    );
  }
  return ids;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const seeded = await harness.fixtures.createTenant({ name: 'Preview Traders' });
  tenantId = seeded.tenantId;
  roles = await harness.provision(tenantId);

  admin = await person(roles.get('Admin')!, 'Anita Admin');
  rahul = await person(roles.get('Manager')!, 'Rahul Manager');
  meera = await person(roles.get('Manager')!, 'Meera Manager');
  priya = await person(roles.get('Sales Rep')!, 'Priya Rep');
  bhavin = await person(roles.get('Sales Rep')!, 'Bhavin Rep');

  await harness.fixtures.createTeam(tenantId, 'North', [rahul.userId, priya.userId]);
  await harness.fixtures.createTeam(tenantId, 'South', [meera.userId, bhavin.userId]);

  // Rahul owns 2, Priya 3 (same team) → Rahul's `team` reach is 5.
  // Meera owns 1, Bhavin 5 (the other team) → Meera's `team` reach is 6.
  await contacts(rahul.userId, 2);
  await contacts(priya.userId, 3);
  await contacts(meera.userId, 1);
  await contacts(bhavin.userId, 5);
}, 240_000);

afterAll(async () => {
  await harness.close();
});

async function previewRole(
  token: string,
  roleId: string,
  body: unknown,
): Promise<{
  status: number;
  data: {
    digest: string;
    people: {
      userId: string;
      scopeChanges: {
        objectType: string;
        action: string;
        before: string | null;
        after: string | null;
        direction: string;
        recordsBefore: number | null;
        recordsAfter: number | null;
        recordsLost: number | null;
        recordsGained: number | null;
      }[];
      fieldChanges: { fieldKey: string; before: string; after: string }[];
    }[];
    unaffectedCount: number;
    summary: {
      objectType: string;
      action: string;
      direction: string;
      peopleAffected: number;
      recordsLostMax: number | null;
      recordViewsLost: number | null;
    }[];
  };
}> {
  const response = await request(harness, {
    method: 'POST',
    url: `/api/v1/roles/${roleId}/permissions/preview`,
    token,
    body,
  });
  return { status: response.status, data: response.body['data'] as never };
}

describe('the effect preview', () => {
  it('says how many records each person loses, and to how many people', async () => {
    const response = await previewRole(admin.token, roles.get('Manager')!, {
      grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
    });
    expect(response.status).toBe(200);

    const byUser = new Map(response.data.people.map((person) => [person.userId, person]));
    const forRahul = byUser.get(rahul.userId)!.scopeChanges.find((c) => c.action === 'read')!;
    const forMeera = byUser.get(meera.userId)!.scopeChanges.find((c) => c.action === 'read')!;

    // Rahul: his own 2 + Priya's 3 → his own 2. Meera: 1 + 5 → 1.
    expect(forRahul).toMatchObject({
      objectType: 'contact',
      before: 'team',
      after: 'own',
      direction: 'narrowed',
      recordsBefore: 5,
      recordsAfter: 2,
      recordsLost: 3,
      recordsGained: 0,
    });
    expect(forMeera).toMatchObject({ recordsBefore: 6, recordsAfter: 1, recordsLost: 5 });

    expect(response.data.summary).toContainEqual(
      expect.objectContaining({
        objectType: 'contact',
        action: 'read',
        direction: 'narrowed',
        peopleAffected: 2,
        recordsLostMax: 5,
        recordViewsLost: 8,
      }),
    );
  });

  it('writes nothing', async () => {
    const before = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${roles.get('Manager')!}`,
      token: admin.token,
    });
    await previewRole(admin.token, roles.get('Manager')!, {
      grants: [{ objectType: 'contact', action: 'read', scope: null }],
      fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'hidden' }],
    });
    const after = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${roles.get('Manager')!}`,
      token: admin.token,
    });
    expect(after.body['data']).toEqual(before.body['data']);
    expect(await harness.fixtures.auditEntries(tenantId, 'role')).toEqual([]);
  });

  it('reports a field going dark as a change of effect, not just of configuration', async () => {
    const response = await previewRole(admin.token, roles.get('Sales Rep')!, {
      fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'hidden' }],
    });
    expect(response.data.people).toHaveLength(2);
    for (const person of response.data.people) {
      expect(person.scopeChanges).toEqual([]);
      expect(person.fieldChanges).toEqual([
        expect.objectContaining({ fieldKey: 'phone', before: 'write', after: 'hidden' }),
      ]);
    }
  });

  it('says nothing is affected when nothing is', async () => {
    const response = await previewRole(admin.token, roles.get('Manager')!, {
      // Already the Manager's grant.
      grants: [{ objectType: 'contact', action: 'read', scope: 'team' }],
    });
    expect(response.data.people).toEqual([]);
    expect(response.data.unaffectedCount).toBe(2);
  });

  it('previews a person changing role with the same machinery', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/members/${rahul.userId}/role-preview`,
      token: admin.token,
      body: { roleId: roles.get('Sales Rep')! },
    });
    expect(response.status).toBe(200);
    const data = response.body['data'] as {
      subject: { kind: string };
      people: { scopeChanges: { objectType: string; action: string; recordsLost: number }[] }[];
    };
    expect(data.subject.kind).toBe('member');
    const read = data.people[0]!.scopeChanges.find(
      (change) => change.objectType === 'contact' && change.action === 'read',
    )!;
    expect(read.recordsLost).toBe(3); // Priya's contacts, which Rahul sees as a teammate
  });

  it('is exactly what the save then does', async () => {
    // Preview, save, and then observe the very numbers on the real list endpoint.
    const role = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Preview then save', copyFromRoleId: roles.get('Manager')! },
    });
    const { id, digest } = role.body['data'] as { id: string; digest: string };
    const holder = await person(id, 'Holder Hari');
    await harness.fixtures.createTeam(tenantId, 'Hari team', [holder.userId, priya.userId]);

    const patch = { grants: [{ objectType: 'contact', action: 'read', scope: 'team' }] };
    const before = (
      await request(harness, {
        method: 'GET',
        url: '/api/v1/contacts?limit=100',
        token: holder.token,
      })
    ).body['data'] as unknown[];
    expect(before).toHaveLength(3); // Priya's three, via the shared team

    const narrowed = {
      grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
    };
    const preview = await previewRole(admin.token, id, narrowed);
    const change = preview.data.people[0]!.scopeChanges.find((c) => c.action === 'read')!;
    expect(change.recordsBefore).toBe(before.length);

    const saved = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: { ...narrowed, expectedDigest: preview.data.digest },
    });
    expect(saved.status).toBe(200);

    const after = (
      await request(harness, {
        method: 'GET',
        url: '/api/v1/contacts?limit=100',
        token: holder.token,
      })
    ).body['data'] as unknown[];
    expect(after).toHaveLength(change.recordsAfter!);
    expect(before.length - after.length).toBe(change.recordsLost);
    void patch;
    void digest;
  });
});

describe('saving a permission change', () => {
  it('audits it as a permission_change, in the same transaction, with exactly the cells that moved', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Audited role', description: 'for the audit test' },
    });
    const { id, digest } = created.body['data'] as { id: string; digest: string };

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        grants: [
          { objectType: 'contact', action: 'read', scope: 'team' },
          { objectType: 'deal', action: 'read', scope: 'all' },
        ],
        fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'hidden' }],
        expectedDigest: digest,
      },
    });
    expect(response.status).toBe(200);

    const entries = (await harness.fixtures.auditEntries(tenantId, 'role')).filter(
      (entry) => entry.recordId === id && entry.action === 'permission_change',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.changes).toEqual({
      'grant:contact.read': { new: 'team' },
      'grant:deal.read': { new: 'all' },
      'field:contact.phone': { new: 'hidden' },
    });
    expect(await harness.fixtures.outboxEventTypes(tenantId)).toContain(
      'role.permissions_changed.v1',
    );
  });

  it('records old and new for a change to an existing cell, and removal as an `old` alone', async () => {
    const detail = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Edited twice', copyFromRoleId: roles.get('Sales Rep')! },
    });
    const { id, digest } = detail.body['data'] as { id: string; digest: string };

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        grants: [
          { objectType: 'contact', action: 'read', scope: 'team' },
          { objectType: 'contact', action: 'export', scope: null },
        ],
        expectedDigest: digest,
      },
    });
    const entries = (await harness.fixtures.auditEntries(tenantId, 'role')).filter(
      (entry) => entry.recordId === id && entry.action === 'permission_change',
    );
    // newest first: the edit, then the cells copied in at creation
    expect(entries[0]!.changes).toEqual({
      'grant:contact.read': { old: 'own', new: 'team' },
      'grant:contact.export': { old: 'own' },
    });
  });

  it('writes nothing, audit included, when the change is refused', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Refused edit' },
    });
    const { id, digest } = created.body['data'] as { id: string; digest: string };
    const before = (await harness.fixtures.auditEntries(tenantId, 'role')).length;

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        // One valid cell and one that cannot be granted: all or nothing.
        grants: [
          { objectType: 'contact', action: 'read', scope: 'own' },
          { objectType: 'activity', action: 'import', scope: 'all' },
        ],
        expectedDigest: digest,
      },
    });
    expect(response.status).toBe(422);

    expect((await harness.fixtures.auditEntries(tenantId, 'role')).length).toBe(before);
    const role = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${id}`,
      token: admin.token,
    });
    expect((role.body['data'] as { grants: unknown[] }).grants).toEqual([]);
  });

  it('refuses scopes and actions that would be wired to nothing', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Catalogue check' },
    });
    const { id, digest } = created.body['data'] as { id: string; digest: string };
    for (const grant of [
      { objectType: 'invitation', action: 'read', scope: 'own' },
      { objectType: 'activity', action: 'export', scope: 'all' },
      { objectType: 'role', action: 'update', scope: 'team' },
    ]) {
      const response = await request(harness, {
        method: 'PATCH',
        url: `/api/v1/roles/${id}/permissions`,
        token: admin.token,
        body: { grants: [grant], expectedDigest: digest },
      });
      expect(response.status, JSON.stringify(grant)).toBe(422);
    }
  });

  it('takes effect on the very next request of the people who hold the role', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Immediate' },
    });
    const { id, digest } = created.body['data'] as { id: string; digest: string };
    const holder = await person(id, 'Holder Ila');

    const denied = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: holder.token,
    });
    expect(denied.status).toBe(403);

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'all' }],
        expectedDigest: digest,
      },
    });
    const allowed = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: holder.token,
    });
    expect(allowed.status).toBe(200);
  });

  it('hides a field from the very next response once its rule is saved', async () => {
    const role = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Sees contacts', copyFromRoleId: roles.get('Read-only')! },
    });
    const { id, digest } = role.body['data'] as { id: string; digest: string };
    const holder = await person(id, 'Holder Hiren');
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Phoned',
      phone: '+919800012345',
    });

    const visible = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${contact}`,
      token: holder.token,
    });
    expect(visible.body['data']).toHaveProperty('phone', '+919800012345');

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'hidden' }],
        expectedDigest: digest,
      },
    });
    const hidden = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${contact}`,
      token: holder.token,
    });
    expect(hidden.body['data']).not.toHaveProperty('phone');
  });
});

describe('roles', () => {
  it('creates, renames, describes and deletes a custom role', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Temporary', description: 'about to go' },
    });
    expect(created.status).toBe(201);
    const { id } = created.body['data'] as { id: string };

    const renamed = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}`,
      token: admin.token,
      body: { name: 'Temporary 2' },
    });
    expect(renamed.body['data']).toMatchObject({ name: 'Temporary 2', isSystem: false });

    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/roles/${id}`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);
    const gone = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${id}`,
      token: admin.token,
    });
    expect(gone.status).toBe(404);

    const trail = (await harness.fixtures.auditEntries(tenantId, 'role'))
      .filter((entry) => entry.recordId === id)
      .map((entry) => entry.action)
      .reverse();
    expect(trail).toEqual(['create', 'update', 'delete']);
  });

  it('keeps system roles: no rename, no delete', async () => {
    const rename = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${roles.get('Sales Rep')!}`,
      token: admin.token,
      body: { name: 'Closers' },
    });
    expect(rename.status).toBe(409);
    const remove = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/roles/${roles.get('Read-only')!}`,
      token: admin.token,
    });
    expect(remove.status).toBe(409);
  });

  it('will not delete a role that still has people in it', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Occupied' },
    });
    const { id } = created.body['data'] as { id: string };
    await person(id, 'Occupant');
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/roles/${id}`,
      token: admin.token,
    });
    expect(response.status).toBe(409);
    expect(response.body['error']).toMatchObject({ code: 'ROLE_IN_USE' });
  });

  it('refuses a duplicate name', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Sales Rep' },
    });
    expect(response.status).toBe(409);
  });

  it('lists roles with how many people hold each', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/roles',
      token: admin.token,
    });
    const list = response.body['data'] as {
      name: string;
      memberCount: number;
      isSystem: boolean;
    }[];
    expect(list.find((role) => role.name === 'Manager')).toMatchObject({
      memberCount: 2,
      isSystem: true,
    });
  });
});

describe('members', () => {
  it('lists people with role and teams', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/members',
      token: admin.token,
    });
    const list = response.body['data'] as {
      name: string;
      roleName: string;
      teams: { name: string }[];
      isYou: boolean;
    }[];
    expect(list.find((member) => member.name === 'Rahul Manager')).toMatchObject({
      roleName: 'Manager',
      teams: [{ name: 'North' }],
      isYou: false,
    });
    expect(list.find((member) => member.name === 'Anita Admin')?.isYou).toBe(true);
  });

  it('changes a role, audited as a permission_change naming both roles', async () => {
    const who = await person(roles.get('Sales Rep')!, 'Promoted Pam');
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${who.userId}`,
      token: admin.token,
      body: { roleId: roles.get('Manager')! },
    });
    expect(response.status).toBe(200);
    expect(response.body['data']).toMatchObject({ roleName: 'Manager' });

    const entries = (await harness.fixtures.auditEntries(tenantId, 'membership')).filter(
      (entry) => entry.recordId === who.userId,
    );
    expect(entries[0]).toMatchObject({
      action: 'permission_change',
      changes: { role: { old: 'Sales Rep', new: 'Manager' } },
    });
  });

  it('applies the new role on that person’s very next request', async () => {
    const who = await person(roles.get('Sales Rep')!, 'Demoted Dan');
    const before = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: who.token,
      body: { lastName: 'Before' },
    });
    expect(before.status).toBe(201);

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${who.userId}`,
      token: admin.token,
      body: { roleId: roles.get('Read-only')! },
    });
    const after = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: who.token,
      body: { lastName: 'After' },
    });
    expect(after.status).toBe(403);
  });

  it('suspends and restores, taking effect on the next request', async () => {
    const who = await person(roles.get('Sales Rep')!, 'Suspended Sue');
    const suspend = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${who.userId}`,
      token: admin.token,
      body: { status: 'suspended' },
    });
    expect(suspend.body['data']).toMatchObject({ status: 'suspended' });
    const refused = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: who.token,
    });
    expect(refused.status).toBeGreaterThanOrEqual(401);

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${who.userId}`,
      token: admin.token,
      body: { status: 'active' },
    });
    const back = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: who.token,
    });
    expect(back.status).toBe(200);
  });
});

describe('teams', () => {
  it('creates, fills, renames and deletes a team, auditing the changes that matter', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'East' },
    });
    expect(created.status).toBe(201);
    const { id } = created.body['data'] as { id: string };

    const filled = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${id}/members`,
      token: admin.token,
      body: { userIds: [priya.userId, bhavin.userId] },
    });
    expect((filled.body['data'] as { members: unknown[] }).members).toHaveLength(2);

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${id}/members`,
      token: admin.token,
      body: { userIds: [priya.userId] },
    });

    const trail = (await harness.fixtures.auditEntries(tenantId, 'team')).filter(
      (entry) => entry.recordId === id,
    );
    const permissionChanges = trail.filter((entry) => entry.action === 'permission_change');
    expect(permissionChanges).toHaveLength(2);
    expect(permissionChanges[0]!.changes).toEqual({ membersRemoved: { old: [bhavin.userId] } });
    expect(permissionChanges[1]!.changes).toEqual({
      membersAdded: { new: expect.arrayContaining([priya.userId, bhavin.userId]) as unknown },
    });

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/teams/${id}`,
      token: admin.token,
    });
    expect(removed.status).toBe(204);
  });

  it('changes who a manager reaches the moment membership changes', async () => {
    const team = await harness.fixtures.createTeam(tenantId, 'Roving', [rahul.userId]);
    const mine = async () =>
      (
        (
          await request(harness, {
            method: 'GET',
            url: '/api/v1/contacts?limit=100',
            token: rahul.token,
          })
        ).body['data'] as unknown[]
      ).length;
    const before = await mine();

    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${team}/members`,
      token: admin.token,
      body: { userIds: [rahul.userId, bhavin.userId] },
    });
    expect(await mine()).toBe(before + 5); // Bhavin's five
  });

  it('refuses a team that would be its own ancestor, and a duplicate name', async () => {
    const parent = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'Parent' },
    });
    const parentId = (parent.body['data'] as { id: string }).id;
    const child = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'Child', parentTeamId: parentId },
    });
    const childId = (child.body['data'] as { id: string }).id;

    const cycle = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${parentId}`,
      token: admin.token,
      body: { parentTeamId: childId },
    });
    expect(cycle.status).toBe(422);
    const self = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${parentId}`,
      token: admin.token,
      body: { parentTeamId: parentId },
    });
    expect(self.status).toBe(422);

    const duplicate = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'Parent' },
    });
    expect(duplicate.status).toBe(409);
  });
});

describe('reassignment', () => {
  async function ownerOf(id: string): Promise<string | null> {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    return (response.body['data'] as { ownerId: string | null }).ownerId;
  }

  it('moves one record: versioned, audited, announced as an ordinary edit would be', async () => {
    const id = await harness.fixtures.createContact(tenantId, {
      ownerId: priya.userId,
      lastName: 'Single move',
    });
    const before = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    const version = (before.body['data'] as { version: number }).version;

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId: bhavin.userId },
    });
    expect(response.status).toBe(200);
    expect(response.body['data']).toEqual({
      moved: [{ objectType: 'contact', count: 1 }],
      skipped: 0,
      remaining: 0,
    });

    expect(await ownerOf(id)).toBe(bhavin.userId);
    const after = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    expect((after.body['data'] as { version: number }).version).toBe(version + 1);

    const audit = (await harness.fixtures.auditEntries(tenantId, 'contact')).find(
      (entry) => entry.recordId === id,
    )!;
    expect(audit).toMatchObject({
      action: 'update',
      changes: { owner_id: { old: priya.userId, new: bhavin.userId } },
    });
    const events = await harness.fixtures.outboxEvents(tenantId, 'contact.updated.v1');
    expect(events.some((event) => event.recordId === id)).toBe(true);
  });

  it('makes a form open on the record learn it is stale', async () => {
    const id = await harness.fixtures.createContact(tenantId, {
      ownerId: priya.userId,
      lastName: 'Stale',
    });
    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    const version = (read.body['data'] as { version: number }).version;

    await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId: bhavin.userId },
    });
    const edit = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { title: 'Late edit', version },
    });
    expect(edit.status).toBe(409);
  });

  it('moves everything one person owns, in bounded batches', async () => {
    const leaver = await person(roles.get('Sales Rep')!, 'Leaving Lal');
    const ids = await contacts(leaver.userId, 4);
    await harness.fixtures.createLead(tenantId, {
      ownerId: leaver.userId,
      lastName: 'Lead of Lal',
    });

    const preview = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/preview',
      token: admin.token,
      body: { mode: 'owner', fromOwnerId: leaver.userId, toOwnerId: meera.userId },
    });
    expect(preview.status).toBe(200);
    const items = (preview.body['data'] as { items: { objectType: string; willMove: number }[] })
      .items;
    expect(items.find((item) => item.objectType === 'contact')?.willMove).toBe(4);
    expect(items.find((item) => item.objectType === 'lead')?.willMove).toBe(1);

    // The preview moved nothing.
    for (const id of ids) expect(await ownerOf(id)).toBe(leaver.userId);

    const run = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: { mode: 'owner', fromOwnerId: leaver.userId, toOwnerId: meera.userId },
    });
    expect(run.body['data']).toMatchObject({ remaining: 0, skipped: 0 });
    for (const id of ids) expect(await ownerOf(id)).toBe(meera.userId);
  });

  it('leaves records already owned by the target alone: no version bump, no audit', async () => {
    const id = await harness.fixtures.createContact(tenantId, {
      ownerId: bhavin.userId,
      lastName: 'Already',
    });
    const before = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId: bhavin.userId },
    });
    expect(response.body['data']).toEqual({ moved: [], skipped: 1, remaining: 0 });
    expect((await harness.fixtures.auditEntries(tenantId, 'contact')).length).toBe(before);
  });

  it('will not hand a record to a suspended person, a stranger, or somebody who cannot see it', async () => {
    const id = await harness.fixtures.createContact(tenantId, {
      ownerId: priya.userId,
      lastName: 'Careful',
    });

    const suspended = await person(roles.get('Sales Rep')!, 'Out Orla');
    await harness.fixtures.setMembershipStatus(tenantId, suspended.userId, 'suspended');
    const blind = await person(
      await harness.fixtures.createRole(tenantId, 'No contacts at all'),
      'Blind Bo',
    );

    for (const toOwnerId of [
      suspended.userId,
      blind.userId,
      '019a0000-0000-7000-8000-00000000dead',
    ]) {
      const response = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: admin.token,
        body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId },
      });
      expect(response.status, toOwnerId).toBe(422);
    }
    expect(await ownerOf(id)).toBe(priya.userId);
  });

  it('re-announces reassigned activities to their new assignee, as an edit would', async () => {
    const id = await harness.fixtures.createActivity(tenantId, {
      assignedTo: priya.userId,
      subject: 'Call back',
      type: 'task',
      dueAt: new Date(Date.now() + 3600_000),
    });
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: { mode: 'records', objectType: 'activity', recordIds: [id], toOwnerId: bhavin.userId },
    });
    expect(response.body['data']).toMatchObject({ moved: [{ objectType: 'activity', count: 1 }] });

    const assigned = await harness.fixtures.outboxEvents(tenantId, 'activity.assigned.v1');
    expect(assigned.find((event) => event.recordId === id)?.payload).toMatchObject({
      assignedTo: bhavin.userId,
    });
  });

  it('lets a manager hand a team activity to a teammate', async () => {
    const activity = await harness.fixtures.createActivity(tenantId, {
      assignedTo: priya.userId,
      subject: 'Team task',
    });

    const task = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: rahul.token,
      body: {
        mode: 'records',
        objectType: 'activity',
        recordIds: [activity],
        toOwnerId: rahul.userId,
      },
    });
    expect(task.status).toBe(200);
    expect(task.body['data']).toMatchObject({ moved: [{ objectType: 'activity', count: 1 }] });
  });

  /**
   * MVP_SPEC section 4: the Manager "sees the team's leads/deals, reassigns work". The default
   * Manager holds `team` scope, so reassigning is allowed inside the team: records the manager can
   * edit, handed to somebody on the manager's own team (or to the manager). Pilot finding F2: it used
   * to answer 422 for every record, so only an Owner or Admin could move a lead.
   */
  describe('a manager on team scope', () => {
    const preview = (token: string, body: Record<string, unknown>) =>
      request(harness, { method: 'POST', url: '/api/v1/ownership/preview', token, body });

    it.each(['contact', 'lead', 'account'] as const)(
      'hands a teammate record (%s) to another person on the team',
      async (objectType) => {
        const teammate = await person(roles.get('Sales Rep')!, `Teammate ${objectType}`);
        await harness.fixtures.createTeam(tenantId, `Team ${objectType} ${teammate.userId}`, [
          rahul.userId,
          teammate.userId,
        ]);
        const id =
          objectType === 'contact'
            ? await harness.fixtures.createContact(tenantId, { ownerId: priya.userId })
            : objectType === 'lead'
              ? await harness.fixtures.createLead(tenantId, { ownerId: priya.userId })
              : await harness.fixtures.createAccount(tenantId, { ownerId: priya.userId });

        const body = { mode: 'records', objectType, recordIds: [id], toOwnerId: teammate.userId };
        const asked = await preview(rahul.token, body);
        expect(asked.status).toBe(200);
        expect(asked.body['data']).toMatchObject({ items: [{ objectType, willMove: 1 }] });

        const run = await request(harness, {
          method: 'POST',
          url: '/api/v1/ownership/reassign',
          token: rahul.token,
          body,
        });
        expect(run.status).toBe(200);
        expect(run.body['data']).toMatchObject({ moved: [{ objectType, count: 1 }], skipped: 0 });

        const audit = (await harness.fixtures.auditEntries(tenantId, objectType)).find(
          (entry) => entry.recordId === id,
        )!;
        expect(audit).toMatchObject({ action: 'update' });
      },
    );

    it('hands a deal to the manager', async () => {
      const pipeline = await harness.fixtures.createPipeline(tenantId, `Reassign ${priya.userId}`, [
        { name: 'Open', stageType: 'open', probability: 10 },
      ]);
      const id = await harness.fixtures.createDeal(tenantId, {
        ownerId: priya.userId,
        pipelineId: pipeline.pipelineId,
        stageId: pipeline.stageIds[0]!,
      });
      const run = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: rahul.token,
        body: { mode: 'records', objectType: 'deal', recordIds: [id], toOwnerId: rahul.userId },
      });
      expect(run.status).toBe(200);
      expect(run.body['data']).toMatchObject({ moved: [{ objectType: 'deal', count: 1 }] });
    });

    it('moves everything one teammate owns, but only inside the manager reach', async () => {
      const leaver = await person(roles.get('Sales Rep')!, 'Leaving Lata');
      const outsider = await person(roles.get('Sales Rep')!, 'Outside Omi');
      await harness.fixtures.createTeam(tenantId, `Leavers ${leaver.userId}`, [
        rahul.userId,
        leaver.userId,
      ]);
      const mine = await contacts(leaver.userId, 3);

      // A teammate's whole book to the manager.
      const run = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: rahul.token,
        body: {
          mode: 'owner',
          fromOwnerId: leaver.userId,
          toOwnerId: rahul.userId,
          objectTypes: ['contact'],
        },
      });
      expect(run.status).toBe(200);
      expect(run.body['data']).toMatchObject({ moved: [{ objectType: 'contact', count: 3 }] });
      for (const id of mine) expect(await ownerOf(id)).toBe(rahul.userId);

      // Somebody outside every team the manager is on: nothing moves.
      const theirs = await contacts(outsider.userId, 2);
      const refused = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: rahul.token,
        body: {
          mode: 'owner',
          fromOwnerId: outsider.userId,
          toOwnerId: rahul.userId,
          objectTypes: ['contact'],
        },
      });
      expect(refused.body['data']).toMatchObject({ moved: [] });
      for (const id of theirs) expect(await ownerOf(id)).toBe(outsider.userId);
    });

    it('does not touch a record owned outside the team, and counts it as skipped', async () => {
      // Not Bhavin: an earlier test here puts him on a team with Rahul.
      const far = await person(roles.get('Sales Rep')!, 'Far Farhan');
      await harness.fixtures.createTeam(tenantId, `Far ${far.userId}`, [far.userId]);
      const southern = await harness.fixtures.createContact(tenantId, { ownerId: far.userId });
      const run = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: rahul.token,
        body: {
          mode: 'records',
          objectType: 'contact',
          recordIds: [southern],
          toOwnerId: rahul.userId,
        },
      });
      expect(run.status).toBe(200);
      expect(run.body['data']).toEqual({ moved: [], skipped: 1, remaining: 0 });
      expect(await ownerOf(southern)).toBe(far.userId);
    });

    it('will not push a record out of the team: the new owner must share a team with the manager', async () => {
      const far = await person(roles.get('Sales Rep')!, 'Distant Dev');
      await harness.fixtures.createTeam(tenantId, `Distant ${far.userId}`, [far.userId]);
      const mine = await harness.fixtures.createContact(tenantId, { ownerId: priya.userId });
      const run = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: rahul.token,
        body: {
          mode: 'records',
          objectType: 'contact',
          recordIds: [mine],
          toOwnerId: far.userId,
        },
      });
      expect(run.status).toBe(422);
      expect(await ownerOf(mine)).toBe(priya.userId);
    });

    it('does not make a Sales Rep (own scope) able to reassign', async () => {
      const mine = await harness.fixtures.createContact(tenantId, { ownerId: priya.userId });
      const run = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/reassign',
        token: priya.token,
        body: {
          mode: 'records',
          objectType: 'contact',
          recordIds: [mine],
          toOwnerId: rahul.userId,
        },
      });
      expect(run.status).toBe(422);
      expect(await ownerOf(mine)).toBe(priya.userId);
    });
  });
});

describe('the catalogue', () => {
  it('lists what can be granted and the fields of each record object', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/access/catalogue',
      token: admin.token,
    });
    expect(response.status).toBe(200);
    const objects = (
      response.body['data'] as {
        objects: {
          objectType: string;
          kind: string;
          actions: string[];
          scopes: string[];
          fields: { key: string }[];
        }[];
      }
    ).objects;
    const deal = objects.find((object) => object.objectType === 'deal')!;
    // Deals became importable in ADR-0070; activities still are not.
    expect(deal.actions).toContain('import');
    expect(objects.find((object) => object.objectType === 'activity')!.actions).not.toContain(
      'import',
    );
    expect(deal.scopes).toEqual(['own', 'team', 'all']);
    expect(deal.fields.length).toBeGreaterThan(3);

    const role = objects.find((object) => object.objectType === 'role')!;
    expect(role).toMatchObject({ kind: 'administrative', scopes: ['all'], fields: [] });
  });
});
