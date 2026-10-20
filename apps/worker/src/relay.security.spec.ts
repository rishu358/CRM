import { createDbClient, withTenant, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { projectTimeline } from './handlers/timeline.js';
import { OutboxRelay } from './relay.js';

/**
 * The relay's two security-relevant properties (ADR-0002, ADR-0006):
 *   it drains events across tenants, because there is one queue, **and**
 *   it still runs every handler inside that event's own tenant scope.
 *
 * Plus idempotency, which at-least-once delivery makes mandatory rather than
 * merely desirable.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let appClient: DbClient;
let fixtures: Fixtures;
let superuserPool: pg.Pool;

let tenantA: string;
let tenantB: string;
let contactA: string;
let contactB: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  appClient = createDbClient({ connectionString: urls.app, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);

  tenantA = (await fixtures.createTenant({ name: 'Relay A' })).tenantId;
  tenantB = (await fixtures.createTenant({ name: 'Relay B' })).tenantId;
  contactA = await fixtures.createContact(tenantA, { lastName: 'Alpha' });
  contactB = await fixtures.createContact(tenantB, { lastName: 'Beta' });
});

afterAll(async () => {
  await Promise.all([worker.close(), appClient.close(), superuserPool.end()]);
});

async function enqueue(tenantId: string, recordId: string, eventType: string): Promise<string> {
  const id = newId();
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload)
      values (${id}, ${tenantId}, ${eventType}, 'contact', ${recordId}, '{}'::jsonb)
    `),
  );
  return id;
}

function relay(): OutboxRelay {
  return new OutboxRelay(worker.db, { logger, batchSize: 100 }).on(
    'contact.created.v1',
    projectTimeline,
  );
}

describe('the relay drains one queue across tenants', () => {
  it('claims events belonging to different tenants in a single batch', async () => {
    await enqueue(tenantA, contactA, 'contact.created.v1');
    await enqueue(tenantB, contactB, 'contact.created.v1');

    const processed = await relay().tick();
    expect(processed).toBeGreaterThanOrEqual(2);

    // Nothing **due** is left. Events dated to the future stay pending by design
    // — reminders, digests and each tenant's Recycle Bin purge sweep are held
    // back by `available_at` (ADR-0025, ADR-0031) — so counting every pending
    // row would fail the moment anything in the database is scheduled.
    const remaining = await withoutTenant(worker.db, (tx) =>
      tx.execute(sql`
        select count(*)::int as pending
        from outbox_events
        where status = 'pending' and available_at <= now()
      `),
    );
    expect((remaining.rows[0] as { pending: number }).pending).toBe(0);
  });

  it('writes each timeline entry into the event own tenant', async () => {
    const fromA = await withTenant(appClient.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(sql`select record_id from timeline_events`),
    );
    const idsInA = fromA.rows.map((row) => (row as { record_id: string }).record_id);
    expect(idsInA).toContain(contactA);
    // The other tenant's projection must not be visible from here.
    expect(idsInA).not.toContain(contactB);
  });
});

describe('handlers run inside the event tenant scope', () => {
  it('gives a handler no access to another tenant rows', async () => {
    const seen: number[] = [];

    const spy = new OutboxRelay(worker.db, { logger }).on('contact.scope_probe.v1', async (tx) => {
      // RLS applies here exactly as it does in the API: a handler that forgets
      // about tenancy sees nothing, never everything.
      const result = await tx.execute(sql`select count(*)::int as total from contacts`);
      seen.push((result.rows[0] as { total: number }).total);
    });

    await enqueue(tenantA, contactA, 'contact.scope_probe.v1');
    await spy.tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(1);
  });
});

describe('at-least-once delivery requires idempotent handlers', () => {
  it('does not duplicate a timeline entry when an event is replayed', async () => {
    const eventId = await enqueue(tenantA, contactA, 'contact.created.v1');
    await relay().tick();

    // Put the same event back as if the worker had crashed after doing the work
    // but before marking the row relayed.
    await withoutTenant(worker.db, (tx) =>
      tx.execute(
        sql`update outbox_events set status = 'pending', available_at = now() where id = ${eventId}`,
      ),
    );
    await relay().tick();

    const entries = await withTenant(appClient.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(
        sql`select count(*)::int as total from timeline_events where source_event_id = ${eventId}`,
      ),
    );
    expect((entries.rows[0] as { total: number }).total).toBe(1);
  });
});

describe('failures back off instead of spinning', () => {
  it('reschedules a failed event into the future and keeps the error', async () => {
    const failing = new OutboxRelay(worker.db, { logger }).on(
      'contact.always_fails.v1',
      async () => {
        await Promise.resolve();
        throw new Error('handler exploded');
      },
    );

    const eventId = await enqueue(tenantA, contactA, 'contact.always_fails.v1');
    await failing.tick();

    const row = await withoutTenant(worker.db, (tx) =>
      tx.execute(
        sql`select status, attempts, last_error, available_at > now() as deferred
            from outbox_events where id = ${eventId}`,
      ),
    );
    const record = row.rows[0] as {
      status: string;
      attempts: number;
      last_error: string;
      deferred: boolean;
    };

    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(1);
    expect(record.last_error).toContain('handler exploded');
    expect(record.deferred).toBe(true);
  });

  it('marks an event relayed when nothing is subscribed to it', async () => {
    const eventId = await enqueue(tenantA, contactA, 'contact.nobody_listens.v1');
    await relay().tick();

    const row = await withoutTenant(worker.db, (tx) =>
      tx.execute(sql`select status from outbox_events where id = ${eventId}`),
    );
    expect((row.rows[0] as { status: string }).status).toBe('relayed');
  });
});

describe('deal events reach the record timeline (MVP_SPEC M5)', () => {
  it('words a stage move as "Moved from X to Y", in the deal own tenant', async () => {
    const dealId = newId();
    const eventId = newId();
    await withoutTenant(worker.db, (tx) =>
      tx.execute(sql`
        insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload)
        values (${eventId}, ${tenantA}, 'deal.stage_changed.v1', 'deal', ${dealId},
                ${JSON.stringify({ fromStageName: 'Qualified', toStageName: 'Proposal' })}::jsonb)
      `),
    );

    await new OutboxRelay(worker.db, { logger, batchSize: 100 })
      .on('deal.stage_changed.v1', projectTimeline)
      .tick();

    const inA = await withTenant(appClient.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(
        sql`select summary, object_type from timeline_events where source_event_id = ${eventId}`,
      ),
    );
    expect(inA.rows[0]).toMatchObject({
      summary: 'Moved from Qualified to Proposal',
      object_type: 'deal',
    });

    const inB = await withTenant(appClient.db, { tenantId: tenantB, userId: null }, (tx) =>
      tx.execute(sql`select 1 from timeline_events where source_event_id = ${eventId}`),
    );
    expect(inB.rows).toHaveLength(0);
  });
});

describe('lead events reach the record timeline (MVP_SPEC M4)', () => {
  async function project(eventType: string, objectType: string, payload: object) {
    const recordId = newId();
    const eventId = newId();
    await withoutTenant(worker.db, (tx) =>
      tx.execute(sql`
        insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload)
        values (${eventId}, ${tenantA}, ${eventType}, ${objectType}, ${recordId},
                ${JSON.stringify(payload)}::jsonb)
      `),
    );
    await new OutboxRelay(worker.db, { logger, batchSize: 100 })
      .on(eventType, projectTimeline)
      .tick();

    const rows = await withTenant(appClient.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(
        sql`select summary, object_type, record_id from timeline_events where source_event_id = ${eventId}`,
      ),
    );
    return { recordId, row: rows.rows[0] as Record<string, string> | undefined };
  }

  it('says what a conversion created, on the lead', async () => {
    const { recordId, row } = await project('lead.converted.v1', 'lead', {
      contactId: newId(),
      accountId: newId(),
      dealId: newId(),
      contactCreated: true,
      accountCreated: true,
    });
    expect(row).toMatchObject({
      summary: 'Converted: created contact, account, deal',
      object_type: 'lead',
      record_id: recordId,
    });
  });

  it('says when a conversion linked to an existing contact', async () => {
    const { row } = await project('lead.converted.v1', 'lead', {
      contactId: newId(),
      accountId: null,
      dealId: null,
      contactCreated: false,
      accountCreated: false,
    });
    expect(row?.['summary']).toBe('Converted and linked to an existing contact');
  });

  it('puts a "linked from lead" entry on a contact that was only linked', async () => {
    const { row } = await project('contact.linked_from_lead.v1', 'contact', { leadId: newId() });
    expect(row).toMatchObject({
      summary: 'Lead converted onto this contact',
      object_type: 'contact',
    });
  });
});
