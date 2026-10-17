import { createDbClient, withTenant, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryEmailProvider } from '../email/provider.js';
import { OutboxRelay } from '../relay.js';
import { pruneActivityLinks } from './activities.js';
import { notifyAssignment, notifyReminder, sendDigest } from './notifications.js';
import { projectTimeline } from './timeline.js';

/**
 * What the worker does with activity events (MVP_SPEC M6, ADR-0025).
 *
 * Everything here is driven through the **real relay** rather than by calling
 * the handlers directly, because the properties that matter — a reminder is
 * not delivered before its time, a redelivered event does not notify twice,
 * a handler runs inside its event's tenant — are the relay's and the
 * database's, not the handler function's.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let appClient: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let email: MemoryEmailProvider;

let tenantId: string;
let userId: string;
let otherTenant: string;
let contactId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  appClient = createDbClient({ connectionString: urls.app, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);

  tenantId = (await fixtures.createTenant({ name: 'Worker Activities' })).tenantId;
  otherTenant = (await fixtures.createTenant({ name: 'Worker Activities B' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Owner');
  const user = await fixtures.createUser(tenantId, roleId, {
    email: `assignee-${Date.now().toString()}@example.com`,
    name: 'Priya',
  });
  userId = user.userId;
  contactId = await fixtures.createContact(tenantId, { lastName: 'Mehta' });
});

afterAll(async () => {
  await Promise.all([worker.close(), appClient.close(), superuserPool.end()]);
});

function relay(): OutboxRelay {
  email = new MemoryEmailProvider();
  const options = {
    email,
    emailFrom: 'no-reply@example.com',
    webUrl: 'https://crm.example',
    // Zero so the digest is deliverable immediately; the delay itself is the
    // outbox's `available_at`, which the reminder cases below exercise.
    digestWindowMinutes: 0,
  };

  return new OutboxRelay(worker.db, { logger, batchSize: 100 })
    .on('activity.assigned.v1', notifyAssignment(options))
    .on('activity.reminder_due.v1', notifyReminder())
    .on('notification.digest_due.v1', sendDigest(options))
    .on('activity.linked.v1', projectTimeline)
    .on('contact.deleted.v1', pruneActivityLinks);
}

/**
 * Put an event on the queue.
 *
 * When no instant is given the row is dated by **the database's** clock, not
 * this process's. The relay claims `available_at <= now()` evaluated in
 * Postgres, and a container whose clock sits a second or two behind the host
 * — routine on a laptop that has slept — would leave a row that looks due
 * here sitting unclaimed there, and then sweep it up inside a later test's
 * tick. That is a flaky suite with no bug behind it.
 */
async function enqueue(
  tenant: string,
  eventType: string,
  objectType: string,
  recordId: string,
  payload: Record<string, unknown>,
  availableAt: Date | null = null,
): Promise<string> {
  const id = newId();
  const due = availableAt === null ? sql`now()` : sql`${availableAt}`;
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${id}, ${tenant}, ${eventType}, ${objectType}, ${recordId},
              ${JSON.stringify(payload)}::jsonb, ${due})
    `),
  );
  return id;
}

describe('assignment notifications', () => {
  it('writes an in-app notification for the assignee', async () => {
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Call the customer',
    });
    await enqueue(tenantId, 'activity.assigned.v1', 'activity', activityId, {
      assignedTo: userId,
      subject: 'Call the customer',
      type: 'task',
    });

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    const notification = rows.find((row) => row.payload['activityId'] === activityId);
    expect(notification?.type).toBe('activity.assigned');
    expect(notification?.payload['subject']).toBe('Call the customer');
  });

  it('does not notify twice when the same event is redelivered', async () => {
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Redelivered',
    });
    const eventId = await enqueue(tenantId, 'activity.assigned.v1', 'activity', activityId, {
      assignedTo: userId,
      subject: 'Redelivered',
    });

    await relay().tick();
    // At-least-once: put the very same row back as if the worker had crashed
    // between doing the work and marking it relayed.
    await withoutTenant(worker.db, (tx) =>
      tx.execute(
        sql`update outbox_events set status = 'pending', available_at = now() where id = ${eventId}`,
      ),
    );
    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    const matching = rows.filter((row) => row.payload['activityId'] === activityId);
    expect(matching).toHaveLength(1);
  });
});

describe('due reminders are scheduled by the outbox, not a timer (ADR-0025)', () => {
  it('leaves a reminder alone until its time has come', async () => {
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Not yet',
      dueAt,
      reminderAt: dueAt,
    });
    await enqueue(
      tenantId,
      'activity.reminder_due.v1',
      'activity',
      activityId,
      { assignedTo: userId, subject: 'Not yet', reminderAt: dueAt.toISOString() },
      dueAt,
    );

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.some((row) => row.payload['activityId'] === activityId)).toBe(false);
  });

  it('notifies once the event becomes due', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Ring now',
      dueAt,
      reminderAt: dueAt,
    });
    await enqueue(
      tenantId,
      'activity.reminder_due.v1',
      'activity',
      activityId,
      { assignedTo: userId, subject: 'Ring now', reminderAt: dueAt.toISOString() },
      dueAt,
    );

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.find((row) => row.payload['activityId'] === activityId)?.type).toBe('activity.due');
  });

  it('says nothing about a task that was completed in the meantime', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Already done',
      dueAt,
      reminderAt: dueAt,
      status: 'completed',
      completedAt: new Date(),
    });
    await enqueue(
      tenantId,
      'activity.reminder_due.v1',
      'activity',
      activityId,
      { assignedTo: userId, subject: 'Already done', reminderAt: dueAt.toISOString() },
      dueAt,
    );

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.some((row) => row.payload['activityId'] === activityId)).toBe(false);
  });

  it('says nothing when the reminder has since been moved', async () => {
    const scheduledFor = new Date(Date.now() - 60_000);
    const movedTo = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Pushed back',
      dueAt: movedTo,
      reminderAt: movedTo,
    });
    await enqueue(
      tenantId,
      'activity.reminder_due.v1',
      'activity',
      activityId,
      { assignedTo: userId, subject: 'Pushed back', reminderAt: scheduledFor.toISOString() },
      scheduledFor,
    );

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.some((row) => row.payload['activityId'] === activityId)).toBe(false);
  });

  it('says nothing about a deleted activity', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Deleted since',
      dueAt,
      reminderAt: dueAt,
    });
    await withTenant(appClient.db, { tenantId, userId: null }, (tx) =>
      tx.execute(sql`update activities set deleted_at = now() where id = ${activityId}`),
    );
    await enqueue(
      tenantId,
      'activity.reminder_due.v1',
      'activity',
      activityId,
      { assignedTo: userId, subject: 'Deleted since', reminderAt: dueAt.toISOString() },
      dueAt,
    );

    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.some((row) => row.payload['activityId'] === activityId)).toBe(false);
  });
});

describe('the email digest', () => {
  it('sends one email covering everything not yet digested, and marks it', async () => {
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Digest me',
    });
    await enqueue(tenantId, 'activity.assigned.v1', 'activity', activityId, {
      assignedTo: userId,
      subject: 'Digest me',
    });

    const running = relay();
    // First tick writes the notification and schedules the digest; the
    // second delivers it, because the window is zero in this test.
    await running.tick();
    await running.tick();

    const message = email.messages().at(-1);
    expect(message?.subject).toContain('update');
    expect(message?.text).toContain('Digest me');
    expect(message?.html).toContain('Digest me');

    const rows = await fixtures.notificationsFor(tenantId, userId);
    expect(rows.find((row) => row.payload['activityId'] === activityId)?.digestedAt).not.toBeNull();
    // Digested is not read: the bell still shows it.
    expect(rows.find((row) => row.payload['activityId'] === activityId)?.readAt).toBeNull();
  });

  it('escapes a subject that contains markup', async () => {
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: '<img src=x onerror=alert(1)>',
    });
    await enqueue(tenantId, 'activity.assigned.v1', 'activity', activityId, {
      assignedTo: userId,
      subject: '<img src=x onerror=alert(1)>',
    });

    const running = relay();
    await running.tick();
    await running.tick();

    const message = email.messages().at(-1);
    expect(message?.html).not.toContain('<img');
    expect(message?.html).toContain('&lt;img');
  });

  it('sends nothing when there is nothing left to say', async () => {
    await enqueue(tenantId, 'notification.digest_due.v1', 'user', userId, { userId });

    const running = relay();
    await running.tick();

    expect(email.messages()).toHaveLength(0);
  });
});

describe('orphaned links are cleared when a record really goes (ADR-0005)', () => {
  it('keeps the link while the record is only soft-deleted', async () => {
    const activityId = await fixtures.createActivity(tenantId, { assignedTo: userId });
    await fixtures.linkActivity(tenantId, activityId, 'contact', contactId);

    await withTenant(appClient.db, { tenantId, userId: null }, (tx) =>
      tx.execute(sql`update contacts set deleted_at = now() where id = ${contactId}`),
    );
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contactId, {});

    await relay().tick();

    // The contact can still come back from the Recycle Bin, and its tasks
    // should still be attached when it does.
    expect(await fixtures.activityLinks(activityId)).toHaveLength(1);
  });

  it('clears the link once the record is gone for good', async () => {
    const doomed = await fixtures.createContact(tenantId, { lastName: 'Purged' });
    const activityId = await fixtures.createActivity(tenantId, { assignedTo: userId });
    await fixtures.linkActivity(tenantId, activityId, 'contact', doomed);

    await fixtures.hardDeleteRecord('contacts', doomed);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', doomed, {});

    await relay().tick();

    expect(await fixtures.activityLinks(activityId)).toHaveLength(0);
  });

  it('touches nothing in another tenant', async () => {
    const theirContact = await fixtures.createContact(otherTenant, { lastName: 'Theirs' });
    const theirActivity = await fixtures.createActivity(otherTenant, {});
    await fixtures.linkActivity(otherTenant, theirActivity, 'contact', theirContact);

    const doomed = await fixtures.createContact(tenantId, { lastName: 'Mine' });
    await fixtures.hardDeleteRecord('contacts', doomed);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', doomed, {});

    await relay().tick();

    expect(await fixtures.activityLinks(theirActivity)).toHaveLength(1);
  });
});

describe('the record timeline', () => {
  it('projects an activity onto the record it is about, not onto itself', async () => {
    const activityId = await fixtures.createActivity(tenantId, {
      assignedTo: userId,
      subject: 'Showroom visit',
      type: 'meeting',
    });
    await enqueue(tenantId, 'activity.linked.v1', 'contact', contactId, {
      activityId,
      activityType: 'meeting',
      subject: 'Showroom visit',
    });

    await relay().tick();

    const entries = await fixtures.timelineFor(tenantId, 'contact', contactId);
    expect(entries.some((entry) => entry.summary === 'Meeting added: Showroom visit')).toBe(true);
  });
});
