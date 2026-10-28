import { createDbClient, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryEmailProvider } from '../email/provider.js';
import { OutboxRelay } from '../relay.js';
import { notifyWebFormDuplicate, notifyWebFormLead, sendDigest } from './notifications.js';
import { projectTimeline } from './timeline.js';

/**
 * What the worker does with a lead a website form made (ADR-0065 7, 8), driven through the real
 * relay: the owner is told, only by id; what the visitor typed never reaches the bell, the timeline
 * entry's wording or the e-mail; and a redelivered event tells nobody twice.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let email: MemoryEmailProvider;
let tenantId: string;
let ownerId: string;
let matchedOwnerId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);
  tenantId = (await fixtures.createTenant({ name: 'Worker Web Forms' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Owner');
  ownerId = (await fixtures.createUser(tenantId, roleId, { name: 'Priya' })).userId;
  matchedOwnerId = (await fixtures.createUser(tenantId, roleId, { name: 'Arjun' })).userId;
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

function relay(): OutboxRelay {
  email = new MemoryEmailProvider();
  const options = {
    email,
    emailFrom: 'no-reply@example.com',
    webUrl: 'https://crm.example',
    appName: 'Sharma & Sons Desk',
    digestWindowMinutes: 0,
  };
  return new OutboxRelay(worker.db, { logger, batchSize: 100 })
    .on('lead.created.v1', notifyWebFormLead(options))
    .on('lead.created.v1', projectTimeline)
    .on('lead.web_form_duplicate.v1', notifyWebFormDuplicate(options))
    .on('lead.web_form_duplicate.v1', projectTimeline)
    .on('notification.digest_due.v1', sendDigest(options));
}

async function enqueue(
  eventType: string,
  recordId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = newId();
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${id}, ${tenantId}, ${eventType}, 'lead', ${recordId},
              ${JSON.stringify(payload)}::jsonb, now())
    `),
  );
  return id;
}

describe('a new lead from a web form', () => {
  it('tells its owner, by id, and writes the timeline entry in plain words', async () => {
    const leadId = await fixtures.createLead(tenantId, {
      ownerId,
      lastName: '<script>alert(1)</script>',
      source: 'web_form',
    });
    await enqueue('lead.created.v1', leadId, { ownerId, source: 'web_form', formId: newId() });
    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, ownerId);
    const found = rows.find((row) => row.payload['leadId'] === leadId);
    expect(found?.type).toBe('lead.web_form_new');
    expect(Object.keys(found!.payload).sort()).toEqual(['formId', 'leadId']);
    expect(JSON.stringify(rows)).not.toContain('script');

    const timeline = await superuserPool.query(
      `select summary from timeline_events where tenant_id = $1 and record_id = $2`,
      [tenantId, leadId],
    );
    expect(timeline.rows).toEqual([{ summary: 'Lead created from a web form' }]);
  });

  it('does not tell anyone about a lead that did not come from a form, or has no owner', async () => {
    const other = await fixtures.createLead(tenantId, { ownerId, lastName: 'Manual' });
    await enqueue('lead.created.v1', other, { ownerId });
    const unowned = await fixtures.createLead(tenantId, { lastName: 'Nobody', source: 'web_form' });
    await enqueue('lead.created.v1', unowned, {
      ownerId: null,
      source: 'web_form',
      formId: newId(),
    });
    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, ownerId);
    expect(rows.some((row) => row.payload['leadId'] === other)).toBe(false);
    expect(rows.some((row) => row.payload['leadId'] === unowned)).toBe(false);
  });

  it('tells nobody twice when the event is redelivered', async () => {
    const leadId = await fixtures.createLead(tenantId, {
      ownerId,
      lastName: 'Twice',
      source: 'web_form',
    });
    const eventId = await enqueue('lead.created.v1', leadId, {
      ownerId,
      source: 'web_form',
      formId: newId(),
    });
    await relay().tick();
    await withoutTenant(worker.db, (tx) =>
      tx.execute(
        sql`update outbox_events set status = 'pending', available_at = now() where id = ${eventId}`,
      ),
    );
    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, ownerId);
    expect(rows.filter((row) => row.payload['leadId'] === leadId)).toHaveLength(1);
  });

  it('puts it in the digest e-mail without a word the visitor typed', async () => {
    const owner = (
      await fixtures.createUser(tenantId, await fixtures.createRole(tenantId, 'Digest Owner'), {
        name: 'Digest <b>Person</b>',
      })
    ).userId;
    const leadId = await fixtures.createLead(tenantId, {
      ownerId: owner,
      lastName: '"><img src=x onerror=alert(1)>',
      source: 'web_form',
    });
    await enqueue('lead.created.v1', leadId, {
      ownerId: owner,
      source: 'web_form',
      formId: newId(),
    });
    const r = relay();
    await r.tick();
    await r.tick();

    expect(email.messages().length).toBeGreaterThan(0);
    const message = email.messages().at(-1)!;
    expect(message.text).toContain('A new lead from a web form is assigned to you');
    expect(message.html).toContain('A new lead from a web form is assigned to you');
    expect(`${message.text}${message.html}`).not.toContain('onerror');
    expect(message.html).not.toContain('<img');
  });
});

describe('a form filled in by somebody who matches an existing record', () => {
  it('tells the matched record’s owner and marks the new lead’s timeline', async () => {
    const leadId = await fixtures.createLead(tenantId, {
      ownerId,
      lastName: 'New',
      source: 'web_form',
    });
    const matchedId = await fixtures.createLead(tenantId, {
      ownerId: matchedOwnerId,
      lastName: 'Old',
    });
    await enqueue('lead.web_form_duplicate.v1', leadId, {
      formId: newId(),
      matchedType: 'lead',
      matchedId,
      matchedOn: ['email'],
      matchedOwnerId,
    });
    await relay().tick();

    const rows = await fixtures.notificationsFor(tenantId, matchedOwnerId);
    const found = rows.find((row) => row.payload['leadId'] === leadId);
    expect(found?.type).toBe('lead.web_form_duplicate');
    expect(found?.payload['matchedId']).toBe(matchedId);

    const timeline = await superuserPool.query(
      `select summary from timeline_events where tenant_id = $1 and record_id = $2 and event_type = 'lead.web_form_duplicate.v1'`,
      [tenantId, leadId],
    );
    expect(timeline.rows).toEqual([
      { summary: 'Possible duplicate of an existing lead (matched on email)' },
    ]);
  });

  it('tells nobody when the matched record has no owner', async () => {
    const leadId = await fixtures.createLead(tenantId, {
      ownerId,
      lastName: 'New2',
      source: 'web_form',
    });
    await enqueue('lead.web_form_duplicate.v1', leadId, {
      formId: newId(),
      matchedType: 'contact',
      matchedId: newId(),
      matchedOn: ['phone'],
      matchedOwnerId: null,
    });
    await relay().tick();
    const rows = await fixtures.notificationsFor(tenantId, matchedOwnerId);
    expect(rows.some((row) => row.payload['leadId'] === leadId)).toBe(false);
  });
});
