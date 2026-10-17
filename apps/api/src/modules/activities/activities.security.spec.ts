import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot list/read/update/delete tenant B records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses and rejected on write
 *   (d) unauthenticated requests get 401
 *
 * Plus the one this module adds, which is the real risk in it: **a
 * polymorphic link must not be a way around record scope** (ADR-0005). An
 * activity has no foreign key to its target, so nothing in the database
 * stops a link pointing at a record the reader may not see; the service has
 * to refuse it on write and hide it on read, and this file is what proves
 * both. And because the body is rich text, a stored XSS payload has to be
 * dead by the time it is read back, whichever path wrote it.
 *
 * All of it goes through the real HTTP stack — the same guards, pipes,
 * filter and database roles as production.
 */

let harness: ApiHarness;

/** Tenant A: an admin with `all` scope and two reps with `own`. */
let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };

/** Tenant B: a separate company that must never be visible from tenant A. */
let tenantB: string;
let adminB: { token: string; userId: string };

let adminActivityA: { id: string; version: number };
let repActivityA: { id: string; version: number };
let activityB: { id: string; version: number };

/** A contact owned by the admin: out of scope for a rep. */
let adminContactA: string;
/** A contact in the other tenant entirely. */
let contactB: string;

type Body = Record<string, unknown>;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);

  const admin = await harness.fixtures.createUser(tenantA, rolesA.get('Admin')!);
  adminA = { userId: admin.userId, token: await harness.signIn(admin.userId, tenantA) };

  // The stock Sales Rep role has no `delete` grant at all, which would make
  // the delete case below pass for the wrong reason — default deny rather
  // than scope. Granting delete at `own` scope is what makes it a real test
  // of "you may delete yours, not a colleague's".
  const repRoleA = rolesA.get('Sales Rep')!;
  await harness.fixtures.grant(tenantA, repRoleA, 'activity', 'delete', 'own');

  const rep = await harness.fixtures.createUser(tenantA, repRoleA);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };

  const otherRep = await harness.fixtures.createUser(tenantA, repRoleA);
  otherRepA = { userId: otherRep.userId, token: await harness.signIn(otherRep.userId, tenantA) };

  const bAdmin = await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!);
  adminB = { userId: bAdmin.userId, token: await harness.signIn(bAdmin.userId, tenantB) };

  adminContactA = await harness.fixtures.createContact(tenantA, {
    ownerId: adminA.userId,
    lastName: 'Mehta',
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
  });

  adminActivityA = await seedActivity(tenantA, adminA.userId, 'Admin task');
  repActivityA = await seedActivity(tenantA, repA.userId, 'Rep task');
  activityB = await seedActivity(tenantB, adminB.userId, 'Rival task');
});

afterAll(async () => {
  await harness.close();
});

async function seedActivity(
  tenantId: string,
  assignedTo: string,
  subject: string,
): Promise<{ id: string; version: number }> {
  const id = await harness.fixtures.createActivity(tenantId, { assignedTo, subject });
  return { id, version: 1 };
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  body?: unknown,
) {
  return request(harness, { method, url: `/api/v1${url}`, token, body });
}

// ---------------------------------------------------------------------------
// (d) unauthenticated
// ---------------------------------------------------------------------------
describe('(d) unauthenticated requests get 401', () => {
  it('rejects every activity route with no credentials', async () => {
    const calls: ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][] = [
      ['GET', '/activities'],
      ['GET', `/activities/${adminActivityA.id}`],
      ['POST', '/activities', { type: 'task', subject: 'Intruder' }],
      ['PATCH', `/activities/${adminActivityA.id}`, { version: 1, subject: 'x' }],
      ['DELETE', `/activities/${adminActivityA.id}?version=1`],
      [
        'POST',
        `/activities/${adminActivityA.id}/links`,
        { objectType: 'contact', recordId: adminContactA },
      ],
    ];

    for (const [method, url, body] of calls) {
      const response = await call(method, url, undefined, body);
      expect(response.status, `${method} ${url}`).toBe(401);
    }
  });

  it('rejects My Day, record views and notifications with no credentials', async () => {
    expect((await call('GET', '/my-day')).status).toBe(401);
    expect(
      (
        await call('POST', '/record-views', undefined, {
          objectType: 'contact',
          recordId: adminContactA,
        })
      ).status,
    ).toBe(401);
    expect((await call('GET', '/notifications')).status).toBe(401);
    expect((await call('GET', '/notifications/unread-count')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (a) tenant isolation
// ---------------------------------------------------------------------------
describe('(a) tenant A cannot reach tenant B activities', () => {
  it('does not list them', async () => {
    const response = await call('GET', '/activities?limit=100', adminA.token);
    expect(response.status).toBe(200);
    const ids = (response.body['data'] as Body[]).map((row) => row['id']);
    expect(ids).not.toContain(activityB.id);
  });

  it('returns 404 for a read, not 403, so the id cannot be probed', async () => {
    const response = await call('GET', `/activities/${activityB.id}`, adminA.token);
    expect(response.status).toBe(404);
  });

  it('cannot update or delete one', async () => {
    const updated = await call('PATCH', `/activities/${activityB.id}`, adminA.token, {
      version: 1,
      subject: 'Stolen',
    });
    expect(updated.status).toBe(404);

    const deleted = await call('DELETE', `/activities/${activityB.id}?version=1`, adminA.token);
    expect(deleted.status).toBe(404);

    // And the row is untouched, not merely hidden from the response.
    const row = await harness.fixtures.activityRow(activityB.id);
    expect(row?.subject).toBe('Rival task');
    expect(row?.deleted_at).toBeNull();
  });

  it('cannot attach an activity to another tenant’s record', async () => {
    const response = await call('POST', '/activities', adminA.token, {
      type: 'task',
      subject: 'Cross-tenant link',
      links: [{ objectType: 'contact', recordId: contactB }],
    });
    expect(response.status).toBe(422);
    expect(await harness.fixtures.countRows('activity_links', tenantB)).toBe(0);
  });

  it('cannot record a view of another tenant’s record', async () => {
    const response = await call('POST', '/record-views', adminA.token, {
      objectType: 'contact',
      recordId: contactB,
    });
    expect(response.status).toBe(404);
  });

  it('cannot list the activities on another tenant’s record', async () => {
    const response = await call(
      'GET',
      `/activities?objectType=contact&recordId=${contactB}`,
      adminA.token,
    );
    // 404 rather than an empty page: an empty page is also what "no
    // activities yet" looks like, and the difference is the oracle.
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (b) record scope
// ---------------------------------------------------------------------------
describe('(b) a rep with own scope sees only their own activities', () => {
  it('lists their own and not a colleague’s', async () => {
    const response = await call('GET', '/activities?limit=100', repA.token);
    const ids = (response.body['data'] as Body[]).map((row) => row['id']);
    expect(ids).toContain(repActivityA.id);
    expect(ids).not.toContain(adminActivityA.id);
  });

  it('gets 404 reading a colleague’s activity', async () => {
    expect((await call('GET', `/activities/${adminActivityA.id}`, repA.token)).status).toBe(404);
  });

  it('cannot update or delete a colleague’s activity', async () => {
    expect(
      (
        await call('PATCH', `/activities/${adminActivityA.id}`, repA.token, {
          version: 1,
          subject: 'Mine now',
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('DELETE', `/activities/${adminActivityA.id}?version=1`, repA.token)).status,
    ).toBe(404);
  });

  it('cannot push work onto another rep', async () => {
    const response = await call('POST', '/activities', repA.token, {
      type: 'task',
      subject: 'You do it',
      assignedTo: otherRepA.userId,
    });
    expect(response.status).toBe(422);
  });

  it('My Day shows only the viewer’s own work even for an admin', async () => {
    const response = await call('GET', '/my-day?timeZone=UTC', adminA.token);
    const day = response.body['data'] as Record<string, Body[]>;
    const ids = [...day['overdue']!, ...day['dueToday']!, ...day['upcoming']!].map(
      (row) => row['id'],
    );
    expect(ids).not.toContain(repActivityA.id);
  });
});

// ---------------------------------------------------------------------------
// The link is not a side door (ADR-0005)
// ---------------------------------------------------------------------------
describe('a polymorphic link is not a way around record scope', () => {
  it('hides a link whose target the reader may not see', async () => {
    // The admin attaches their own contact to an activity, then hands the
    // activity to the rep. The rep may now read the activity — it is theirs —
    // but the contact is still outside their scope.
    const created = await call('POST', '/activities', adminA.token, {
      type: 'task',
      subject: 'Handed over with a link',
      assignedTo: repA.userId,
      links: [{ objectType: 'contact', recordId: adminContactA }],
    });
    expect(created.status).toBe(201);
    const id = (created.body['data'] as Body)['id'] as string;

    // The admin sees the link.
    const asAdmin = await call('GET', `/activities/${id}`, adminA.token);
    expect((asAdmin.body['data'] as Body)['links']).toHaveLength(1);

    // The rep sees the activity, and no link at all — not a null, not a
    // placeholder, nothing that confirms a contact is attached.
    const asRep = await call('GET', `/activities/${id}`, repA.token);
    expect(asRep.status).toBe(200);
    expect((asRep.body['data'] as Body)['links']).toEqual([]);

    // The link row is still there: it is hidden from this reader, not deleted.
    expect(await harness.fixtures.activityLinks(id)).toHaveLength(1);
  });

  it('refuses to create a link to a record outside the actor’s scope', async () => {
    const response = await call('POST', '/activities', repA.token, {
      type: 'task',
      subject: 'Reaching for a colleague’s contact',
      links: [{ objectType: 'contact', recordId: adminContactA }],
    });
    expect(response.status).toBe(422);

    // Same message as a record that does not exist, so the error says
    // nothing about which ids are real.
    const error = response.body['error'] as { details: { message: string }[] };
    expect(error.details[0]?.message).toBe('That record does not exist');
  });

  it('refuses to list the activities on a record outside the actor’s scope', async () => {
    const response = await call(
      'GET',
      `/activities?objectType=contact&recordId=${adminContactA}`,
      repA.token,
    );
    expect(response.status).toBe(404);
  });

  it('refuses to record a view of a record outside the actor’s scope', async () => {
    const response = await call('POST', '/record-views', repA.token, {
      objectType: 'contact',
      recordId: adminContactA,
    });
    expect(response.status).toBe(404);
  });

  it('rejects an object_type that is not a linkable one', async () => {
    const response = await call('POST', '/activities', adminA.token, {
      type: 'task',
      subject: 'Invented object type',
      links: [{ objectType: 'invitation', recordId: adminContactA }],
    });
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// (c) field permissions
// ---------------------------------------------------------------------------
describe('(c) hidden fields are stripped on read and rejected on write', () => {
  let restrictedRole: string;
  let restricted: { token: string; userId: string };
  let theirActivity: string;

  beforeAll(async () => {
    restrictedRole = await harness.fixtures.createRole(tenantA, 'Activity Clerk');
    await harness.fixtures.grantAll(tenantA, restrictedRole, 'activity', 'all');
    await harness.fixtures.grantAll(tenantA, restrictedRole, 'contact', 'all');
    // The notes on a call can hold anything; a clerk books the slot.
    await harness.fixtures.setFieldPermission(
      tenantA,
      restrictedRole,
      'activity',
      'body',
      'hidden',
    );
    await harness.fixtures.setFieldPermission(
      tenantA,
      restrictedRole,
      'activity',
      'priority',
      'read',
    );

    const user = await harness.fixtures.createUser(tenantA, restrictedRole);
    restricted = { userId: user.userId, token: await harness.signIn(user.userId, tenantA) };

    theirActivity = await harness.fixtures.createActivity(tenantA, {
      assignedTo: restricted.userId,
      subject: 'Private notes',
      body: '<p>Customer is unhappy about the delay</p>',
      priority: 'high',
    });
  });

  it('omits a hidden field rather than returning it as null', async () => {
    const response = await call('GET', `/activities/${theirActivity}`, restricted.token);
    expect(response.status).toBe(200);
    const activity = response.body['data'] as Body;

    expect('body' in activity).toBe(false);
    expect(activity['subject']).toBe('Private notes');
    expect(activity['priority']).toBe('high');
  });

  it('keeps the hidden field out of the list as well as the record', async () => {
    const response = await call('GET', '/activities?limit=100', restricted.token);
    for (const row of response.body['data'] as Body[]) {
      expect('body' in row).toBe(false);
    }
  });

  it('keeps it out of My Day too', async () => {
    await call('PATCH', `/activities/${theirActivity}`, restricted.token, {
      version: 1,
      dueAt: new Date().toISOString(),
    });

    const response = await call('GET', '/my-day?timeZone=UTC', restricted.token);
    const day = response.body['data'] as Record<string, Body[]>;
    for (const row of [...day['overdue']!, ...day['dueToday']!, ...day['upcoming']!]) {
      expect('body' in row).toBe(false);
    }
  });

  it('rejects a write to a hidden field instead of dropping it', async () => {
    const response = await call('POST', '/activities', restricted.token, {
      type: 'note',
      subject: 'Trying to write notes',
      body: '<p>should not be stored</p>',
    });
    expect(response.status).toBe(403);
    expect((response.body['error'] as Body)['code']).toBe('FIELD_NOT_WRITABLE');
  });

  it('rejects a write to a read-only field the same way', async () => {
    const response = await call('POST', '/activities', restricted.token, {
      type: 'task',
      subject: 'Trying to set priority',
      priority: 'high',
    });
    expect(response.status).toBe(403);
  });

  it('does not let a hidden field be read through sort or filter', async () => {
    const sorted = await call('GET', '/activities?sort=body', restricted.token);
    expect(sorted.status).toBe(422);

    const filtered = await call(
      'GET',
      '/activities?filter=body:starts_with:Customer',
      restricted.token,
    );
    expect(filtered.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Stored rich text (ADR-0024)
// ---------------------------------------------------------------------------
describe('stored XSS payloads are dead on arrival and on the way out', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)></svg>',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<body onload=alert(1)>',
    '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
    '<p style="background:url(javascript:alert(1))">styled</p>',
  ];

  it.each(payloads)('refuses to store %s', async (payload) => {
    const created = await call('POST', '/activities', adminA.token, {
      type: 'note',
      subject: 'Payload',
      body: `<p>before</p>${payload}`,
    });
    expect(created.status).toBe(201);

    const id = (created.body['data'] as Body)['id'] as string;
    const stored = (await harness.fixtures.activityRow(id))?.body ?? '';
    const returned = ((created.body['data'] as Body)['body'] as string | null) ?? '';

    for (const text of [stored, returned]) {
      const lowered = text.toLowerCase();
      expect(lowered).not.toContain('<script');
      expect(lowered).not.toContain('<svg');
      expect(lowered).not.toContain('<iframe');
      expect(lowered).not.toContain('<img');
      expect(lowered).not.toContain('<math');
      expect(lowered).not.toMatch(/\son[a-z]+\s*=/);
      expect(lowered).not.toContain('javascript:');
      expect(lowered).not.toContain('style=');
    }
  });

  it('sanitizes on the way out even for a row written behind the API', async () => {
    // An import, a seed, a restored backup — anything that did not come
    // through the service. The read path must still be safe (ADR-0024).
    const id = await harness.fixtures.createActivity(tenantA, {
      assignedTo: adminA.userId,
      subject: 'Written straight into the table',
      body: '<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
    });

    const response = await call('GET', `/activities/${id}`, adminA.token);
    const body = ((response.body['data'] as Body)['body'] as string).toLowerCase();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('javascript:');
    expect(body).toContain('ok');
  });
});

// ---------------------------------------------------------------------------
// Notifications belong to one person
// ---------------------------------------------------------------------------
describe('notifications are readable only by the person they are addressed to', () => {
  let mine: string;
  let theirs: string;
  let otherTenant: string;

  beforeAll(async () => {
    mine = await harness.fixtures.createNotification(tenantA, adminA.userId, {
      payload: { subject: 'For the admin' },
    });
    theirs = await harness.fixtures.createNotification(tenantA, repA.userId, {
      payload: { subject: 'For the rep' },
    });
    otherTenant = await harness.fixtures.createNotification(tenantB, adminB.userId, {
      payload: { subject: 'For the rival' },
    });
  });

  it('lists only the caller’s own', async () => {
    const response = await call('GET', '/notifications?limit=100', adminA.token);
    const ids = (response.body['data'] as Body[]).map((row) => row['id']);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(otherTenant);
  });

  it('refuses to mark a colleague’s notification as read', async () => {
    const response = await call('POST', `/notifications/${theirs}/read`, adminA.token, {});
    expect(response.status).toBe(404);

    const rows = await harness.fixtures.notificationsFor(tenantA, repA.userId);
    expect(rows.find((row) => row.id === theirs)?.readAt).toBeNull();
  });

  it('refuses to mark another tenant’s notification as read', async () => {
    const response = await call('POST', `/notifications/${otherTenant}/read`, adminA.token, {});
    expect(response.status).toBe(404);
  });

  it('read-all stops at the caller’s own', async () => {
    await call('POST', '/notifications/read-all', adminA.token, {});

    const others = await harness.fixtures.notificationsFor(tenantA, repA.userId);
    expect(others.every((row) => row.readAt === null)).toBe(true);
  });
});
