import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for activities, My Day and notifications (MVP_SPEC M6).
 *
 * Against real Postgres with RLS on, like every other test here. The things
 * under test — a reminder is an outbox row dated to the future, "today" is
 * cut on the viewer's zone, a body is sanitized before it is stored — are
 * database and boundary behaviour, and a mock would agree with whatever this
 * file expects.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };
let rep: { token: string; userId: string };
let contactId: string;
let dealId: string;

type Body = Record<string, unknown>;
interface LinkView {
  objectType: string;
  recordId: string;
  label: string;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const tenant = await harness.fixtures.createTenant({ name: 'Activities Behaviour Co' });
  tenantId = tenant.tenantId;
  const roles = await harness.provision(tenantId);

  const a = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: a.userId, token: await harness.signIn(a.userId, tenantId) };
  const r = await harness.fixtures.createUser(tenantId, roles.get('Sales Rep')!);
  rep = { userId: r.userId, token: await harness.signIn(r.userId, tenantId) };

  contactId = await harness.fixtures.createContact(tenantId, {
    ownerId: admin.userId,
    lastName: 'Mehta',
  });

  const pipelines = await harness.fixtures.pipelinesFor(tenantId);
  const pipeline = pipelines[0]!;
  dealId = await harness.fixtures.createDeal(tenantId, {
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0]!.id,
    ownerId: admin.userId,
    name: 'Diwali order',
  });
});

afterAll(async () => {
  await harness.close();
});

function post(url: string, body: Body, token = admin.token) {
  return request(harness, { method: 'POST', url: `/api/v1${url}`, token, body });
}

function patch(url: string, body: Body, token = admin.token) {
  return request(harness, { method: 'PATCH', url: `/api/v1${url}`, token, body });
}

function get(url: string, token = admin.token) {
  return request(harness, { method: 'GET', url: `/api/v1${url}`, token });
}

function del(url: string, token = admin.token) {
  return request(harness, { method: 'DELETE', url: `/api/v1${url}`, token });
}

async function createActivity(body: Body, token = admin.token): Promise<Body> {
  const response = await post('/activities', body, token);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body['data'] as Body;
}

describe('creating an activity', () => {
  it('assigns it to the actor, audits it and emits an event', async () => {
    const activity = await createActivity({ type: 'task', subject: 'Call back about the quote' });

    expect(activity['assignedTo']).toBe(admin.userId);
    expect(activity['status']).toBe('open');
    expect(activity['priority']).toBe('normal');
    expect(activity['completedAt']).toBeNull();

    const audit = await harness.fixtures.auditEntries(tenantId, 'activity');
    expect(
      audit.some((entry) => entry.action === 'create' && entry.recordId === activity['id']),
    ).toBe(true);
    expect(await harness.fixtures.outboxEventTypes(tenantId)).toContain('activity.created.v1');
  });

  it('attaches it to records and returns the resolved links', async () => {
    const activity = await createActivity({
      type: 'meeting',
      subject: 'Showroom visit',
      links: [
        { objectType: 'contact', recordId: contactId },
        { objectType: 'deal', recordId: dealId },
      ],
    });

    const links = activity['links'] as LinkView[];
    expect(links.map((link) => link.objectType).sort()).toEqual(['contact', 'deal']);
    expect(links.find((link) => link.objectType === 'contact')?.label).toBe('Mehta');
    expect(links.find((link) => link.objectType === 'deal')?.label).toBe('Diwali order');

    // One event per link, carrying the *target* so the worker projects it
    // onto that record's timeline rather than onto the activity (ADR-0005).
    const linked = await harness.fixtures.outboxEvents(tenantId, 'activity.linked.v1');
    expect(linked.some((event) => event.recordId === contactId)).toBe(true);
    expect(linked.some((event) => event.recordId === dealId)).toBe(true);
  });

  it('refuses a link to a record that does not exist, without saying which', async () => {
    const response = await post('/activities', {
      type: 'task',
      subject: 'Phantom',
      links: [{ objectType: 'contact', recordId: '00000000-0000-7000-8000-000000000000' }],
    });

    expect(response.status).toBe(422);
    const error = response.body['error'] as { details: { message: string }[] };
    expect(error.details[0]?.message).toBe('That record does not exist');
  });

  it('refuses a due date on a note, which has nothing to be due', async () => {
    const response = await post('/activities', {
      type: 'note',
      subject: 'Walked in asking about bangles',
      dueAt: '2026-11-01T09:00:00.000Z',
    });
    expect(response.status).toBe(422);
  });

  it('rejects an unknown key rather than dropping it', async () => {
    const response = await post('/activities', {
      type: 'task',
      subject: 'Sneaky',
      completedAt: '2026-11-01T09:00:00.000Z',
    });
    expect(response.status).toBe(422);
  });
});

describe('rich text', () => {
  it('stores the body sanitized, not as it was sent (ADR-0024)', async () => {
    const activity = await createActivity({
      type: 'note',
      subject: 'Call notes',
      body: '<p>Wants <strong>22k</strong></p><script>alert(1)</script><img src=x onerror=alert(1)>',
    });

    // What is in the column, not just what the API returned: the second pass
    // in the serializer must not be the only thing standing between a stored
    // payload and a browser.
    const row = await harness.fixtures.activityRow(activity['id'] as string);
    expect(row?.body).toBe('<p>Wants <strong>22k</strong></p>');
    expect(activity['body']).toBe('<p>Wants <strong>22k</strong></p>');
  });

  it('keeps a safe link but strips a javascript: one', async () => {
    const activity = await createActivity({
      type: 'note',
      subject: 'Links',
      body: '<a href="https://example.com">catalogue</a> <a href="javascript:alert(1)">no</a>',
    });

    const body = activity['body'] as string;
    expect(body).toContain('href="https://example.com"');
    expect(body).toContain('rel="noopener noreferrer nofollow"');
    expect(body.toLowerCase()).not.toContain('javascript:');
  });

  it('sanitizes an edit as well as a creation', async () => {
    const activity = await createActivity({ type: 'note', subject: 'Edited later' });
    const response = await patch(`/activities/${activity['id'] as string}`, {
      version: activity['version'],
      // The prose comes first on purpose: anything *inside* a discarded tag
      // goes with it, so `<svg><p>after</p></svg>` would correctly leave an
      // empty body and prove nothing about the edit path.
      body: '<p>after</p><svg onload=alert(1)></svg>',
    });

    expect(response.status).toBe(200);
    const row = await harness.fixtures.activityRow(activity['id'] as string);
    expect(row?.body?.toLowerCase()).not.toContain('svg');
    expect(row?.body).toContain('after');
  });
});

describe('completing and editing', () => {
  it('stamps completedAt from the status and clears it again', async () => {
    const activity = await createActivity({ type: 'task', subject: 'Send revised quote' });
    const id = activity['id'] as string;

    const completed = await patch(`/activities/${id}`, {
      version: activity['version'],
      status: 'completed',
    });
    expect(completed.status).toBe(200);
    const after = completed.body['data'] as Body;
    expect(after['status']).toBe('completed');
    expect(after['completedAt']).not.toBeNull();

    const reopened = await patch(`/activities/${id}`, {
      version: after['version'],
      status: 'open',
    });
    expect((reopened.body['data'] as Body)['completedAt']).toBeNull();
  });

  it('refuses a stale version with 409 rather than clobbering', async () => {
    const activity = await createActivity({ type: 'task', subject: 'Concurrent edit' });
    const id = activity['id'] as string;

    const first = await patch(`/activities/${id}`, { version: activity['version'], subject: 'A' });
    expect(first.status).toBe(200);

    const second = await patch(`/activities/${id}`, { version: activity['version'], subject: 'B' });
    expect(second.status).toBe(409);
  });

  it('soft deletes, so the row survives for the Recycle Bin', async () => {
    const activity = await createActivity({ type: 'task', subject: 'Delete me' });
    const id = activity['id'] as string;

    const response = await del(`/activities/${id}?version=${String(activity['version'])}`);
    expect(response.status).toBe(204);
    expect((await get(`/activities/${id}`)).status).toBe(404);

    const row = await harness.fixtures.activityRow(id);
    expect(row?.deleted_at).not.toBeNull();
  });
});

describe('links', () => {
  it('attaches and detaches after the fact', async () => {
    const activity = await createActivity({ type: 'call', subject: 'Rang about delivery' });
    const id = activity['id'] as string;

    const attached = await post(`/activities/${id}/links`, {
      objectType: 'contact',
      recordId: contactId,
    });
    expect(attached.status).toBe(201);
    expect((attached.body['data'] as Body)['links']).toHaveLength(1);

    const detached = await del(`/activities/${id}/links?objectType=contact&recordId=${contactId}`);
    expect(detached.status).toBe(204);
    expect(await harness.fixtures.activityLinks(id)).toHaveLength(0);
  });

  it('lists the activities on one record', async () => {
    const activity = await createActivity({
      type: 'task',
      subject: 'Record page list',
      links: [{ objectType: 'contact', recordId: contactId }],
    });

    const response = await get(`/activities?objectType=contact&recordId=${contactId}`);
    expect(response.status).toBe(200);
    const ids = (response.body['data'] as Body[]).map((row) => row['id']);
    expect(ids).toContain(activity['id']);
  });

  it('refuses half of a polymorphic pair', async () => {
    expect((await get(`/activities?recordId=${contactId}`)).status).toBe(422);
  });
});

describe('reminders are scheduled through the outbox (ADR-0025)', () => {
  it('dates the reminder event to the due time', async () => {
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);
    const activity = await createActivity({
      type: 'task',
      subject: 'Ring at noon',
      dueAt: dueAt.toISOString(),
    });

    const scheduled = await harness.fixtures.outboxSchedule(tenantId, 'activity.reminder_due.v1');
    const mine = scheduled.find((event) => event.recordId === activity['id']);
    expect(mine).toBeDefined();
    expect(mine?.availableAt.toISOString()).toBe(dueAt.toISOString());
    expect(mine?.payload['reminderAt']).toBe(dueAt.toISOString());
  });

  it('leads the due time when asked to', async () => {
    const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const activity = await createActivity({
      type: 'meeting',
      subject: 'Showroom appointment',
      dueAt: dueAt.toISOString(),
      reminderMinutesBefore: 30,
    });

    const row = await harness.fixtures.activityRow(activity['id'] as string);
    expect(row?.reminder_at?.toISOString()).toBe(
      new Date(dueAt.getTime() - 30 * 60_000).toISOString(),
    );
  });

  it('schedules nothing for a due date that has already passed', async () => {
    const activity = await createActivity({
      type: 'task',
      subject: 'Already late',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const row = await harness.fixtures.activityRow(activity['id'] as string);
    expect(row?.reminder_at).toBeNull();
  });

  it('clears the reminder when the task is completed', async () => {
    const activity = await createActivity({
      type: 'task',
      subject: 'Completed before it was due',
      dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    await patch(`/activities/${activity['id'] as string}`, {
      version: activity['version'],
      status: 'completed',
    });

    const row = await harness.fixtures.activityRow(activity['id'] as string);
    expect(row?.reminder_at).toBeNull();
  });
});

describe('assignment', () => {
  it('emits an assignment event when the work goes to somebody else', async () => {
    const activity = await createActivity({
      type: 'task',
      subject: 'Over to you',
      assignedTo: rep.userId,
    });

    const events = await harness.fixtures.outboxEvents(tenantId, 'activity.assigned.v1');
    const mine = events.find((event) => event.recordId === activity['id']);
    expect(mine?.payload['assignedTo']).toBe(rep.userId);
  });

  it('emits nothing when somebody assigns work to themselves', async () => {
    const before = (await harness.fixtures.outboxEvents(tenantId, 'activity.assigned.v1')).length;
    await createActivity({ type: 'task', subject: 'Mine', assignedTo: admin.userId });
    const after = (await harness.fixtures.outboxEvents(tenantId, 'activity.assigned.v1')).length;
    expect(after).toBe(before);
  });

  it('refuses a rep with own scope handing work to a colleague', async () => {
    const response = await post(
      '/activities',
      { type: 'task', subject: 'Not mine to give', assignedTo: admin.userId },
      rep.token,
    );
    expect(response.status).toBe(422);
  });
});

describe('My Day', () => {
  /**
   * The point of these cases is the time zone.
   *
   * A task at 18:45Z is 00:15 *tomorrow* in Kolkata and still today in UTC,
   * so the same row has to land in different buckets for the two viewers.
   * Getting this wrong moves people's work between days without any error.
   */
  it('cuts the buckets on the viewer’s calendar, not on UTC', async () => {
    const date = '2026-10-17';
    const justBeforeKolkataMidnight = '2026-10-17T18:15:00.000Z';

    const activity = await createActivity({
      type: 'task',
      subject: 'Late evening call',
      dueAt: justBeforeKolkataMidnight,
    });

    const kolkata = await get(`/my-day?timeZone=Asia/Kolkata&date=${date}`);
    expect(kolkata.status).toBe(200);
    const kolkataDay = kolkata.body['data'] as Record<string, Body[]>;
    // 23:45 on the 17th in Kolkata: today.
    expect(kolkataDay['dueToday']?.map((row) => row['id'])).toContain(activity['id']);

    const utc = await get(`/my-day?timeZone=UTC&date=${date}`);
    const utcDay = utc.body['data'] as Record<string, Body[]>;
    expect(utcDay['dueToday']?.map((row) => row['id'])).toContain(activity['id']);

    // And the other side of the boundary: 18:45Z is tomorrow in Kolkata.
    const tomorrowThere = await createActivity({
      type: 'task',
      subject: 'Just after midnight there',
      dueAt: '2026-10-17T18:45:00.000Z',
    });
    const kolkataAgain = await get(`/my-day?timeZone=Asia/Kolkata&date=${date}`);
    const again = kolkataAgain.body['data'] as Record<string, Body[]>;
    expect(again['dueToday']?.map((row) => row['id'])).not.toContain(tomorrowThere['id']);
    expect(again['upcoming']?.map((row) => row['id'])).toContain(tomorrowThere['id']);
  });

  it('separates overdue from upcoming', async () => {
    const overdue = await createActivity({
      type: 'task',
      subject: 'Overdue task',
      dueAt: '2026-10-10T06:00:00.000Z',
    });
    const upcoming = await createActivity({
      type: 'task',
      subject: 'Upcoming task',
      dueAt: '2026-10-20T06:00:00.000Z',
    });

    const response = await get('/my-day?timeZone=UTC&date=2026-10-17');
    const day = response.body['data'] as Record<string, Body[]>;
    expect(day['overdue']?.map((row) => row['id'])).toContain(overdue['id']);
    expect(day['upcoming']?.map((row) => row['id'])).toContain(upcoming['id']);
  });

  it('shows only the viewer’s own work', async () => {
    const theirs = await createActivity({
      type: 'task',
      subject: 'Rep’s own task',
      dueAt: '2026-10-17T06:00:00.000Z',
      assignedTo: rep.userId,
    });

    const mine = await get('/my-day?timeZone=UTC&date=2026-10-17');
    const day = mine.body['data'] as Record<string, Body[]>;
    const allIds = [...day['overdue']!, ...day['dueToday']!, ...day['upcoming']!].map(
      (row) => row['id'],
    );
    expect(allIds).not.toContain(theirs['id']);

    const theirDay = await get('/my-day?timeZone=UTC&date=2026-10-17', rep.token);
    const theirs2 = theirDay.body['data'] as Record<string, Body[]>;
    expect(theirs2['dueToday']?.map((row) => row['id'])).toContain(theirs['id']);
  });

  it('refuses an unknown time zone rather than quietly using UTC', async () => {
    const response = await get('/my-day?timeZone=Mars/Olympus');
    expect(response.status).toBe(422);
  });

  it('lists recently viewed records, newest first', async () => {
    expect(
      (await post('/record-views', { objectType: 'contact', recordId: contactId })).status,
    ).toBe(204);
    expect((await post('/record-views', { objectType: 'deal', recordId: dealId })).status).toBe(
      204,
    );

    const response = await get('/my-day?timeZone=UTC');
    const recent = (response.body['data'] as Record<string, Body[]>)['recentlyViewed']!;
    expect(recent[0]?.['objectType']).toBe('deal');
    expect(recent.map((row) => row['recordId'])).toContain(contactId);
    expect(recent[0]?.['label']).toBe('Diwali order');
  });
});

describe('notifications', () => {
  it('lists only the signed-in person’s own, with an unread count', async () => {
    await harness.fixtures.createNotification(tenantId, admin.userId, {
      type: 'activity.assigned',
      payload: { subject: 'Yours' },
    });
    await harness.fixtures.createNotification(tenantId, rep.userId, {
      type: 'activity.assigned',
      payload: { subject: 'Theirs' },
    });

    const response = await get('/notifications');
    expect(response.status).toBe(200);
    const rows = response.body['data'] as Body[];
    const subjects = rows.map((row) => (row['payload'] as Body)['subject']);
    expect(subjects).toContain('Yours');
    expect(subjects).not.toContain('Theirs');

    const meta = response.body['meta'] as { unread: number };
    expect(meta.unread).toBeGreaterThan(0);
  });

  it('marks one as read, and then all of them', async () => {
    const id = await harness.fixtures.createNotification(tenantId, admin.userId, {
      payload: { subject: 'Mark me' },
    });

    expect((await post(`/notifications/${id}/read`, {})).status).toBe(204);

    const all = await post('/notifications/read-all', {});
    expect(all.status).toBe(201);

    const count = await get('/notifications/unread-count');
    expect((count.body['data'] as { unread: number }).unread).toBe(0);
  });
});
