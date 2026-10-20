import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10), for the
 * users / roles / teams / ownership module and the access explainer:
 *
 *   (a) tenant A cannot list, read, change or delete tenant B's roles, members,
 *       teams or records — through any of these endpoints, including the
 *       explainer, the effect preview and reassignment
 *   (b) a user with `own` scope cannot learn about others' records through the
 *       explainer, and cannot count what they could not list
 *   (c) a field hidden from the viewer is absent from every explanation
 *   (d) unauthenticated requests get 401
 *
 * and the rules particular to a feature that reads across people:
 *
 *   - only administrators may use any of it: a sales rep (or a manager, whose
 *     role does not read the permission configuration) learns nothing — not
 *     who their colleagues are, not their own role's grants, not which fields
 *     are hidden from them
 *   - nobody can hand out access beyond their own, or lock the workspace out
 *
 * Through the real HTTP stack: the guards, pipes, filter and database roles are
 * all part of what is being asserted.
 */
let harness: ApiHarness;

interface Person {
  userId: string;
  token: string;
}

let tenantA: string;
let tenantB: string;
let admin: Person;
let manager: Person;
let rep: Person;
/** Reads the permission configuration, but sees only their own contacts. */
let ownScopeAdmin: Person;
/** Edits roles, but only holds `team` scope on contacts themselves. */
let teamScopeEditor: Person;
/** An administrator who cannot read the contact `phone` field. */
let phoneBlindAdmin: Person;
let rolesA: ReadonlyMap<string, string>;

let ownedByAdminContact: string;
let ownedByRepContact: string;
let ownScopeAdminContact: string;

let rolesB: ReadonlyMap<string, string>;
let adminB: Person;
let contactB: string;
let teamB: string;

async function person(tenantId: string, roleId: string, name = 'Test User'): Promise<Person> {
  const created = await harness.fixtures.createUser(tenantId, roleId, { name });
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

async function customAdminRole(
  tenantId: string,
  name: string,
  contactScope: 'own' | 'team' | 'all',
  extra: { roleUpdate?: boolean } = {},
): Promise<string> {
  const roleId = await harness.fixtures.createRole(tenantId, name);
  await harness.fixtures.grant(tenantId, roleId, 'role', 'read', 'all');
  await harness.fixtures.grant(tenantId, roleId, 'membership', 'read', 'all');
  await harness.fixtures.grant(tenantId, roleId, 'contact', 'read', contactScope);
  if (extra.roleUpdate === true) {
    await harness.fixtures.grant(tenantId, roleId, 'role', 'update', 'all');
    await harness.fixtures.grant(tenantId, roleId, 'role', 'create', 'all');
    await harness.fixtures.grant(tenantId, roleId, 'membership', 'update', 'all');
  }
  return roleId;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const a = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = a.tenantId;
  rolesA = await harness.provision(tenantA);
  admin = await person(tenantA, rolesA.get('Admin')!, 'Anita Admin');
  manager = await person(tenantA, rolesA.get('Manager')!, 'Manish Manager');
  rep = await person(tenantA, rolesA.get('Sales Rep')!, 'Priya Rep');

  ownScopeAdmin = await person(
    tenantA,
    await customAdminRole(tenantA, 'People viewer (own contacts)', 'own'),
    'Olive Own',
  );
  teamScopeEditor = await person(
    tenantA,
    await customAdminRole(tenantA, 'Role editor (team contacts)', 'team', { roleUpdate: true }),
    'Tess Team',
  );

  const phoneBlind = await customAdminRole(tenantA, 'Admin without phone', 'all');
  await harness.fixtures.setFieldPermission(tenantA, phoneBlind, 'contact', 'phone', 'hidden');
  phoneBlindAdmin = await person(tenantA, phoneBlind, 'Pat Phoneless');

  ownedByAdminContact = await harness.fixtures.createContact(tenantA, {
    ownerId: admin.userId,
    lastName: 'AdminOwned',
    phone: '+919811111111',
  });
  ownedByRepContact = await harness.fixtures.createContact(tenantA, {
    ownerId: rep.userId,
    lastName: 'RepOwned',
    phone: '+919822222222',
  });
  ownScopeAdminContact = await harness.fixtures.createContact(tenantA, {
    ownerId: ownScopeAdmin.userId,
    lastName: 'OwnScopeOwned',
    phone: '+919833333333',
  });

  const b = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = b.tenantId;
  rolesB = await harness.provision(tenantB);
  adminB = await person(tenantB, rolesB.get('Admin')!, 'Bela Rival');
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'RivalContact',
  });
  teamB = await harness.fixtures.createTeam(tenantB, 'Rival Team', [adminB.userId]);
}, 240_000);

afterAll(async () => {
  await harness.close();
});

/** Every route this module serves, with a body where one is required. */
function routes(): { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown }[] {
  const id = '019a0000-0000-7000-8000-000000000000';
  return [
    { method: 'GET', url: '/api/v1/access/catalogue' },
    { method: 'GET', url: '/api/v1/roles' },
    { method: 'POST', url: '/api/v1/roles', body: { name: 'X' } },
    { method: 'GET', url: `/api/v1/roles/${id}` },
    { method: 'PATCH', url: `/api/v1/roles/${id}`, body: { name: 'Y' } },
    { method: 'DELETE', url: `/api/v1/roles/${id}` },
    {
      method: 'POST',
      url: `/api/v1/roles/${id}/permissions/preview`,
      body: { grants: [{ objectType: 'contact', action: 'read', scope: 'own' }] },
    },
    {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
        expectedDigest: 'x'.repeat(40),
      },
    },
    { method: 'GET', url: '/api/v1/members' },
    { method: 'PATCH', url: `/api/v1/members/${id}`, body: { status: 'suspended' } },
    { method: 'POST', url: `/api/v1/members/${id}/role-preview`, body: { roleId: id } },
    { method: 'GET', url: '/api/v1/teams' },
    { method: 'POST', url: '/api/v1/teams', body: { name: 'T' } },
    { method: 'PATCH', url: `/api/v1/teams/${id}`, body: { name: 'U' } },
    { method: 'DELETE', url: `/api/v1/teams/${id}` },
    { method: 'PATCH', url: `/api/v1/teams/${id}/members`, body: { userIds: [] } },
    {
      method: 'POST',
      url: '/api/v1/ownership/preview',
      body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId: id },
    },
    {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      body: { mode: 'records', objectType: 'contact', recordIds: [id], toOwnerId: id },
    },
    { method: 'GET', url: `/api/v1/access/records/contact/${id}` },
    { method: 'GET', url: `/api/v1/access/members/${id}` },
    { method: 'GET', url: `/api/v1/access/roles/${id}` },
  ];
}

// ---------------------------------------------------------------------------
// (d) unauthenticated
// ---------------------------------------------------------------------------

describe('(d) unauthenticated requests', () => {
  it('get 401 on every route, and the body says nothing about what exists', async () => {
    for (const route of routes()) {
      const response = await request(harness, { ...route });
      expect(response.status, `${route.method} ${route.url}`).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/Acme|Priya|Anita/);
    }
  });
});

// ---------------------------------------------------------------------------
// Only administrators
// ---------------------------------------------------------------------------

describe('only administrators may use any of it', () => {
  it.each([
    ['a sales rep', () => rep],
    ['a manager', () => manager],
  ])('refuses %s on every route with 403', async (_label, who) => {
    for (const route of routes()) {
      const response = await request(harness, { ...route, token: who().token });
      if (route.url.startsWith('/api/v1/ownership')) {
        // Reps and managers may edit records within their scope, so what they
        // are refused here is *assigning to somebody else* (a 422, exactly as on
        // a PATCH with an `ownerId`). It must never be a success; the next test
        // holds the answer to being independent of who is named.
        expect([403, 422], `${route.method} ${route.url}`).toContain(response.status);
        continue;
      }
      expect(response.status, `${route.method} ${route.url}`).toBe(403);
      expect(response.body['error']).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('does not let a rep discover which fields are hidden from them, or who their colleagues are', async () => {
    const reach = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/members/${rep.userId}`,
      token: rep.token,
    });
    expect(reach.status).toBe(403);
    expect(JSON.stringify(reach.body)).not.toMatch(/hidden|field|Anita|Manish/);

    const people = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownedByRepContact}`,
      token: rep.token,
    });
    // Even for a record they own, and could open themselves.
    expect(people.status).toBe(403);

    const members = await request(harness, { method: 'GET', url: '/api/v1/members', token: rep.token });
    expect(members.status).toBe(403);
  });

  it('answers the same 403 whether or not the record exists, so ids cannot be probed through it', async () => {
    const real = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownedByAdminContact}`,
      token: rep.token,
    });
    const absent = await request(harness, {
      method: 'GET',
      url: '/api/v1/access/records/contact/019a0000-0000-7000-8000-00000000dead',
      token: rep.token,
    });
    expect(real.status).toBe(403);
    expect(absent.status).toBe(403);
  });

  it('does not let reassignment be used to find out who is a member', async () => {
    // Somebody who may not reassign must get the same answer whether the person
    // they name exists or not — otherwise the refusal is a membership oracle.
    for (const who of [rep, manager]) {
      const named = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/preview',
        token: who.token,
        body: {
          mode: 'records',
          objectType: 'contact',
          recordIds: [ownedByRepContact],
          toOwnerId: admin.userId,
        },
      });
      const invented = await request(harness, {
        method: 'POST',
        url: '/api/v1/ownership/preview',
        token: who.token,
        body: {
          mode: 'records',
          objectType: 'contact',
          recordIds: [ownedByRepContact],
          toOwnerId: '019a0000-0000-7000-8000-00000000dead',
        },
      });
      expect(named.status).toBe(invented.status);
      const shape = (body: Record<string, unknown>) => ({
        ...(body['error'] as Record<string, unknown>),
        requestId: undefined,
      });
      expect(shape(named.body)).toEqual(shape(invented.body));
    }
  });

  it('accepts no tenant, user or role-name in a request body', async () => {
    for (const body of [
      { name: 'Sneaky', tenantId: tenantB },
      { name: 'Sneaky', isSystem: true },
      { name: 'Sneaky', createdBy: rep.userId },
    ]) {
      const response = await request(harness, {
        method: 'POST',
        url: '/api/v1/roles',
        token: admin.token,
        body,
      });
      expect(response.status).toBe(422);
    }
  });
});

// ---------------------------------------------------------------------------
// (a) tenant isolation
// ---------------------------------------------------------------------------

describe('(a) tenant A cannot reach tenant B', () => {
  it('does not list B’s roles, members or teams', async () => {
    const roles = await request(harness, { method: 'GET', url: '/api/v1/roles', token: admin.token });
    const roleIds = (roles.body['data'] as { id: string }[]).map((role) => role.id);
    for (const roleId of rolesB.values()) expect(roleIds).not.toContain(roleId);

    const members = await request(harness, {
      method: 'GET',
      url: '/api/v1/members',
      token: admin.token,
    });
    expect(JSON.stringify(members.body)).not.toContain(adminB.userId);
    expect(JSON.stringify(members.body)).not.toContain('Bela Rival');

    const teams = await request(harness, { method: 'GET', url: '/api/v1/teams', token: admin.token });
    expect(JSON.stringify(teams.body)).not.toContain(teamB);
    expect(JSON.stringify(teams.body)).not.toContain('Rival Team');
  });

  it('answers 404, never 403, for B’s role, member and team by id', async () => {
    const bRole = rolesB.get('Sales Rep')!;
    const attempts: [string, 'GET' | 'PATCH' | 'DELETE' | 'POST', string, unknown?][] = [
      ['read role', 'GET', `/api/v1/roles/${bRole}`],
      ['rename role', 'PATCH', `/api/v1/roles/${bRole}`, { name: 'Hijacked' }],
      ['delete role', 'DELETE', `/api/v1/roles/${bRole}`],
      [
        'preview role',
        'POST',
        `/api/v1/roles/${bRole}/permissions/preview`,
        { grants: [{ objectType: 'contact', action: 'read', scope: 'own' }] },
      ],
      [
        'edit role permissions',
        'PATCH',
        `/api/v1/roles/${bRole}/permissions`,
        {
          grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
          expectedDigest: 'x'.repeat(40),
        },
      ],
      ['suspend member', 'PATCH', `/api/v1/members/${adminB.userId}`, { status: 'suspended' }],
      [
        'preview member role',
        'POST',
        `/api/v1/members/${adminB.userId}/role-preview`,
        { roleId: rolesA.get('Sales Rep')! },
      ],
      ['rename team', 'PATCH', `/api/v1/teams/${teamB}`, { name: 'Mine now' }],
      ['delete team', 'DELETE', `/api/v1/teams/${teamB}`],
      ['set team members', 'PATCH', `/api/v1/teams/${teamB}/members`, { userIds: [admin.userId] }],
      ['explain B’s role', 'GET', `/api/v1/access/roles/${bRole}`],
      ['explain B’s member', 'GET', `/api/v1/access/members/${adminB.userId}`],
      ['explain B’s record', 'GET', `/api/v1/access/records/contact/${contactB}`],
    ];

    for (const [label, method, url, body] of attempts) {
      const response = await request(harness, {
        method,
        url,
        token: admin.token,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, label).toBe(404);
    }

    // And nothing happened to B.
    const roleRows = await harness.fixtures.auditEntries(tenantB, 'role');
    expect(roleRows).toEqual([]);
  });

  it('refuses to put B’s ids into A’s configuration', async () => {
    // A member moved to a role that belongs to B.
    const toForeignRole = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${rep.userId}`,
      token: admin.token,
      body: { roleId: rolesB.get('Owner')! },
    });
    expect(toForeignRole.status).toBe(422);

    // A role copied from B's.
    const copied = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Stolen', copyFromRoleId: rolesB.get('Owner')! },
    });
    expect(copied.status).toBe(404);

    // B's user put on A's team.
    const team = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'Mixed' },
    });
    const teamId = (team.body['data'] as { id: string }).id;
    const members = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}/members`,
      token: admin.token,
      body: { userIds: [adminB.userId] },
    });
    expect(members.status).toBe(422);

    // A team parented on B's.
    const parented = await request(harness, {
      method: 'POST',
      url: '/api/v1/teams',
      token: admin.token,
      body: { name: 'Child of rival', parentTeamId: teamB },
    });
    expect(parented.status).toBe(422);
  });

  it('will not reassign B’s records, or hand A’s records to B’s people', async () => {
    const intoA = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: {
        mode: 'records',
        objectType: 'contact',
        recordIds: [contactB],
        toOwnerId: admin.userId,
      },
    });
    expect(intoA.status).toBe(200);
    expect(intoA.body['data']).toMatchObject({ moved: [], skipped: 1 });

    const stillB = await harness.fixtures.auditEntries(tenantB, 'contact');
    expect(stillB).toEqual([]);

    const toB = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: admin.token,
      body: {
        mode: 'records',
        objectType: 'contact',
        recordIds: [ownedByAdminContact],
        toOwnerId: adminB.userId,
      },
    });
    expect(toB.status).toBe(422);
  });

  it('never names B in an explanation of A’s record', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownedByAdminContact}`,
      token: admin.token,
    });
    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(adminB.userId);
    expect(text).not.toContain('Bela Rival');
    expect(text).not.toContain('Rival Traders');
  });
});

// ---------------------------------------------------------------------------
// (b) own scope
// ---------------------------------------------------------------------------

describe('(b) a viewer with `own` scope learns nothing about records beyond their own', () => {
  it('explains a record they own', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownScopeAdminContact}`,
      token: ownScopeAdmin.token,
    });
    expect(response.status).toBe(200);
  });

  it('answers 404 — not 403 — for another person’s record, as opening it would', async () => {
    const theirs = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownedByAdminContact}`,
      token: ownScopeAdmin.token,
    });
    expect(theirs.status).toBe(404);

    const direct = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${ownedByAdminContact}`,
      token: ownScopeAdmin.token,
    });
    expect(direct.status).toBe(404);

    // Indistinguishable from a record that does not exist.
    const absent = await request(harness, {
      method: 'GET',
      url: '/api/v1/access/records/contact/019a0000-0000-7000-8000-00000000dead',
      token: ownScopeAdmin.token,
    });
    expect(absent.status).toBe(404);
    const strip = (body: Record<string, unknown>) => ({
      ...(body['error'] as Record<string, unknown>),
      requestId: undefined,
    });
    expect(strip(theirs.body)).toEqual(strip(absent.body));
  });

  it('gives no record counts to somebody who could not count them themselves', async () => {
    const reach = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/members/${rep.userId}`,
      token: ownScopeAdmin.token,
    });
    expect(reach.status).toBe(200);
    const objects = (reach.body['data'] as { objects: { readableRecords: number | null }[] })
      .objects;
    // `own` scope on contacts, and nothing on the rest: no object they may count in full.
    for (const object of objects) expect(object.readableRecords).toBeNull();
  });

  it('gives no counts in a preview either, though the change itself is shown', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Preview target');
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    await person(tenantA, roleId, 'Holder');

    const editorRole = await customAdminRole(tenantA, 'Own-scope role editor', 'own', {
      roleUpdate: true,
    });
    const editor = await person(tenantA, editorRole, 'Edna Editor');

    const preview = await request(harness, {
      method: 'POST',
      url: `/api/v1/roles/${roleId}/permissions/preview`,
      token: editor.token,
      body: { grants: [{ objectType: 'contact', action: 'read', scope: 'own' }] },
    });
    expect(preview.status).toBe(200);
    const data = preview.body['data'] as {
      people: { scopeChanges: { direction: string; recordsLost: number | null }[] }[];
    };
    expect(data.people).toHaveLength(1);
    expect(data.people[0]!.scopeChanges[0]).toMatchObject({
      direction: 'narrowed',
      recordsLost: null,
    });
  });

  it('refuses to reassign records outside the actor’s own update scope, without saying why', async () => {
    // Own-scope viewer holds no `update`, so this is a refusal of the action…
    const noUpdate = await request(harness, {
      method: 'POST',
      url: '/api/v1/ownership/reassign',
      token: ownScopeAdmin.token,
      body: {
        mode: 'records',
        objectType: 'contact',
        recordIds: [ownedByAdminContact],
        toOwnerId: admin.userId,
      },
    });
    expect(noUpdate.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// (c) hidden fields
// ---------------------------------------------------------------------------

describe('(c) a field hidden from the viewer is absent from every explanation', () => {
  it('is not listed, and no person’s access to it is described', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${ownedByRepContact}`,
      token: phoneBlindAdmin.token,
    });
    expect(response.status).toBe(200);
    const data = response.body['data'] as {
      fields: { key: string }[];
      people: { hiddenFields: string[]; readOnlyFields: string[] }[];
    };

    expect(data.fields.map((field) => field.key)).not.toContain('phone');
    expect(data.fields.map((field) => field.key)).toContain('email');
    for (const person of data.people) {
      expect(person.hiddenFields).not.toContain('phone');
      expect(person.readOnlyFields).not.toContain('phone');
    }
    expect(JSON.stringify(response.body)).not.toMatch(/"phone"|\+9198/);
  });

  it('is not listed in what a person can reach, or in the catalogue-driven effect of a change', async () => {
    const reach = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/members/${rep.userId}`,
      token: phoneBlindAdmin.token,
    });
    expect(reach.status).toBe(200);
    const contact = (
      reach.body['data'] as { objects: { objectType: string; fields: { key: string }[] }[] }
    ).objects.find((object) => object.objectType === 'contact')!;
    expect(contact.fields.map((field) => field.key)).not.toContain('phone');

    const asAdmin = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/members/${rep.userId}`,
      token: admin.token,
    });
    const full = (
      asAdmin.body['data'] as { objects: { objectType: string; fields: { key: string }[] }[] }
    ).objects.find((object) => object.objectType === 'contact')!;
    // The control: somebody who can read it is told about it.
    expect(full.fields.map((field) => field.key)).toContain('phone');
  });

  it('rejects a field rule for a field that does not exist, in the same words as any other', async () => {
    const role = rolesA.get('Sales Rep')!;
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/roles/${role}/permissions/preview`,
      token: admin.token,
      body: { fieldRules: [{ objectType: 'contact', fieldKey: 'no_such_field', access: 'hidden' }] },
    });
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// No escalation, no lock-out
// ---------------------------------------------------------------------------

describe('nobody can hand out more than they hold, or lock the workspace out', () => {
  it('refuses a grant wider than the editor’s own reach', async () => {
    const role = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: teamScopeEditor.token,
      body: { name: 'Escalation target' },
    });
    expect(role.status).toBe(201);
    const { id, digest } = role.body['data'] as { id: string; digest: string };

    // They hold contact:read at `team`, so `all` is beyond them.
    const wider = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: teamScopeEditor.token,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'all' }],
        expectedDigest: digest,
      },
    });
    expect(wider.status).toBe(403);
    expect(wider.body['error']).toMatchObject({ code: 'PERMISSION_ESCALATION' });

    // Something they hold nothing of is beyond them too.
    const unheld = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: teamScopeEditor.token,
      body: {
        grants: [{ objectType: 'deal', action: 'delete', scope: 'own' }],
        expectedDigest: digest,
      },
    });
    expect(unheld.status).toBe(403);

    // At or below their own reach is fine.
    const within = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: teamScopeEditor.token,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'team' }],
        expectedDigest: digest,
      },
    });
    expect(within.status).toBe(200);
  });

  it('shows what is beyond the editor in the preview, before they try to save', async () => {
    const role = rolesA.get('Read-only')!;
    const preview = await request(harness, {
      method: 'POST',
      url: `/api/v1/roles/${role}/permissions/preview`,
      token: teamScopeEditor.token,
      body: { grants: [{ objectType: 'deal', action: 'update', scope: 'all' }] },
    });
    expect(preview.status).toBe(200);
    expect((preview.body['data'] as { beyondYourAccess: unknown[] }).beyondYourAccess).toEqual([
      { objectType: 'deal', action: 'update', scope: 'all' },
    ]);
  });

  it('refuses to move somebody into a role wider than the editor’s own', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${rep.userId}`,
      token: teamScopeEditor.token,
      body: { roleId: rolesA.get('Owner')! },
    });
    expect(response.status).toBe(403);
    expect(response.body['error']).toMatchObject({ code: 'PERMISSION_ESCALATION' });

    const unchanged = await request(harness, {
      method: 'GET',
      url: '/api/v1/members?limit=200',
      token: admin.token,
    });
    const priya = (unchanged.body['data'] as { userId: string; roleName: string }[]).find(
      (member) => member.userId === rep.userId,
    );
    expect(priya?.roleName).toBe('Sales Rep');
  });

  it('refuses to copy a role the editor could not hold', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: teamScopeEditor.token,
      body: { name: 'Copy of Owner', copyFromRoleId: rolesA.get('Owner')! },
    });
    expect(response.status).toBe(403);
  });
});

describe('the workspace keeps an administrator', () => {
  it('rolls back a change that would remove the last one, and says why', async () => {
    // A workspace of its own, with exactly one administrator.
    const lone = await harness.fixtures.createTenant({ name: 'One Admin Ltd' });
    const roles = await harness.provision(lone.tenantId);
    const only = await person(lone.tenantId, roles.get('Admin')!, 'Only Admin');
    const rep = await person(lone.tenantId, roles.get('Sales Rep')!, 'A Rep');
    void rep;

    const adminRole = roles.get('Admin')!;
    const detail = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${adminRole}`,
      token: only.token,
    });
    const digest = (detail.body['data'] as { digest: string }).digest;

    const removeRoleUpdate = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${adminRole}/permissions`,
      token: only.token,
      body: {
        grants: [{ objectType: 'role', action: 'update', scope: null }],
        expectedDigest: digest,
      },
    });
    expect(removeRoleUpdate.status).toBe(409);
    expect(removeRoleUpdate.body['error']).toMatchObject({ code: 'LAST_ADMINISTRATOR' });

    // The whole change rolled back: the grant is still there, and nothing was audited.
    const after = await request(harness, {
      method: 'GET',
      url: `/api/v1/roles/${adminRole}`,
      token: only.token,
    });
    expect(
      (after.body['data'] as { grants: { objectType: string; action: string }[] }).grants.some(
        (grant) => grant.objectType === 'role' && grant.action === 'update',
      ),
    ).toBe(true);
    const audit = await harness.fixtures.auditEntries(lone.tenantId, 'role');
    expect(audit.filter((entry) => entry.action === 'permission_change')).toEqual([]);

    // Demoting or suspending the only administrator is the same lock-out.
    const demote = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${only.userId}`,
      token: only.token,
      body: { roleId: roles.get('Sales Rep')! },
    });
    expect([403, 409]).toContain(demote.status);
    const suspendSelf = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/members/${only.userId}`,
      token: only.token,
      body: { status: 'suspended' },
    });
    expect(suspendSelf.status).toBe(422);
  });

  it('flags the lock-out in the preview before anybody tries to save', async () => {
    const lone = await harness.fixtures.createTenant({ name: 'Another One Admin Ltd' });
    const roles = await harness.provision(lone.tenantId);
    const only = await person(lone.tenantId, roles.get('Admin')!, 'Sole Admin');

    const preview = await request(harness, {
      method: 'POST',
      url: `/api/v1/roles/${roles.get('Admin')!}/permissions/preview`,
      token: only.token,
      body: { grants: [{ objectType: 'membership', action: 'update', scope: null }] },
    });
    expect(preview.status).toBe(200);
    expect((preview.body['data'] as { removesLastAdministrator: boolean }).removesLastAdministrator).toBe(
      true,
    );
  });
});

describe('what was previewed is what is saved', () => {
  it('refuses a save whose preview was of a state that no longer exists', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/roles',
      token: admin.token,
      body: { name: 'Digest check' },
    });
    const { id, digest } = created.body['data'] as { id: string; digest: string };

    const first = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
        expectedDigest: digest,
      },
    });
    expect(first.status).toBe(200);

    // A second administrator still holding the old preview.
    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/roles/${id}/permissions`,
      token: admin.token,
      body: {
        grants: [{ objectType: 'contact', action: 'read', scope: 'all' }],
        expectedDigest: digest,
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
