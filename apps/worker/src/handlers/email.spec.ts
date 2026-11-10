import { createDbClient, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryEmailProvider } from '../email/provider.js';
import { OutboxRelay } from '../relay.js';
import { failEmailOnExhaustion, sendQueuedEmail, watchEmail } from './email.js';
import { projectTimeline } from './timeline.js';

/**
 * What the worker does with an email somebody queued from a record (ADR-0073), driven through the real
 * relay: it sends once and only once, a temporary failure is tried again, a final one is closed with a
 * code and no more tries, a message a crashed worker left behind is noticed, and nothing about the
 * person (address, subject, body) reaches an event or the timeline.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let email: MemoryEmailProvider;
let tenantId: string;
let userId: string;
let contactId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);
  tenantId = (await fixtures.createTenant({ name: 'Worker Email' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Rep');
  userId = (await fixtures.createUser(tenantId, roleId, { name: 'Priya' })).userId;
  contactId = await fixtures.createContact(tenantId, {
    ownerId: userId,
    lastName: 'Sharma',
    email: 'sharma@customer.example',
  });
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

function relay(options: { maxAttempts?: number } = {}): OutboxRelay {
  email = new MemoryEmailProvider();
  const deps = {
    db: worker.db,
    email,
    logger,
    origins: { web: 'https://app.example', api: 'https://api.example' },
  };
  const instance = new OutboxRelay(worker.db, {
    logger,
    batchSize: 100,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
    .on('email.queued.v1', sendQueuedEmail(deps))
    .on('email.watchdog_due.v1', watchEmail(deps))
    .on('email.sent.v1', projectTimeline)
    .on('email.failed.v1', projectTimeline);
  instance.onExhausted('email.queued.v1', failEmailOnExhaustion(deps));
  return instance;
}

async function queueEmail(
  options: { status?: string; body?: string; erased?: boolean; token?: string | null } = {},
): Promise<string> {
  const id = newId();
  await superuserPool.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, contact_id, from_name,
        from_address, reply_to, to_address, subject, body_text, message_id, created_by, updated_by,
        erased_at, unsubscribe_token)
     values ($1, $2, $3, 'contact', $4, $4, 'Sharma Traders', 'mail@send.example',
             'priya@sharma.example', $5, $6, $7, $8, $9, $9, $10, $11)`,
    [
      id,
      tenantId,
      options.status ?? 'queued',
      contactId,
      options.erased === true ? null : 'sharma@customer.example',
      options.erased === true ? '' : 'Your quote',
      options.body ?? 'Hello <b>Sharma</b>,\n\nThe quote is attached.',
      `<${id}@send.example>`,
      userId,
      options.erased === true ? new Date() : null,
      options.token ?? null,
    ],
  );
  await superuserPool.query(
    `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
     values ($1, $2, $3, 'contact', $4)`,
    [newId(), tenantId, id, contactId],
  );
  return id;
}

async function enqueue(eventType: string, emailId: string, availableAt = 'now()'): Promise<string> {
  const id = newId();
  await withoutTenant(worker.db, (tx) =>
    tx.execute(
      sql.raw(
        `insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
         values ('${id}', '${tenantId}', '${eventType}', 'email_message', '${emailId}',
                 '{"emailId":"${emailId}"}'::jsonb, ${availableAt})`,
      ),
    ),
  );
  return id;
}

const rowOf = async (id: string) =>
  (
    await superuserPool.query<{
      status: string;
      failure_code: string | null;
      provider_message_id: string | null;
      attempts: number;
      sent_at: Date | null;
    }>(
      `select status, failure_code, provider_message_id, attempts, sent_at
       from email_messages where id = $1`,
      [id],
    )
  ).rows[0]!;

const eventsFor = async (emailId: string) =>
  (
    await superuserPool.query<{
      event_type: string;
      object_type: string;
      record_id: string;
      payload: Record<string, unknown>;
      status: string;
    }>(
      `select event_type, object_type, record_id, payload, status from outbox_events
       where tenant_id = $1 and payload ->> 'emailId' = $2 order by id`,
      [tenantId, emailId],
    )
  ).rows;

describe('sending a queued email', () => {
  it('sends it once, as the company, and records what the provider said', async () => {
    await superuserPool.query(
      `insert into email_sender_config (id, tenant_id, from_name, footer_text)
       values ($1, $2, 'Sharma Traders', 'Sharma Traders, Pune') on conflict do nothing`,
      [newId(), tenantId],
    );
    const id = await queueEmail();
    await enqueue('email.queued.v1', id);
    await relay().tick();

    expect(email.messages()).toHaveLength(1);
    const sent = email.messages()[0]!;
    expect(sent).toMatchObject({
      to: 'sharma@customer.example',
      subject: 'Your quote',
      fromName: 'Sharma Traders',
      replyTo: 'priya@sharma.example',
      messageId: `<${id}@send.example>`,
    });
    // The body is text: markup the sender typed is escaped in the HTML part, never passed through.
    expect(sent.text).toBe(
      'Hello <b>Sharma</b>,\n\nThe quote is attached.\n\n-- \nSharma Traders, Pune',
    );
    expect(sent.html).toContain('&lt;b&gt;Sharma&lt;/b&gt;');
    expect(sent.html).not.toContain('<b>');

    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'sent', failure_code: null, attempts: 1 });
    expect(row.provider_message_id).toMatch(/^memory-/);
    expect(row.sent_at).not.toBeNull();
  });

  it('puts the unsubscribe sentence and the mail program’s headers in an email that has a token', async () => {
    const token = `v1.${newId()}.${'A'.repeat(43)}`;
    const id = await queueEmail({ token });
    await enqueue('email.queued.v1', id);
    await relay().tick();

    const sent = email.messages()[0]!;
    expect(sent.text).toContain(
      `To stop receiving email from Sharma Traders, open: https://app.example/u/${token}`,
    );
    expect(sent.html).toContain(`<a href="https://app.example/u/${token}">unsubscribe</a>`);
    // The address a mail program posts to is the API's, not the page's.
    expect(sent.unsubscribeUrl).toBe(
      `https://api.example/api/v1/public/email-unsubscribe/${token}`,
    );
  });

  it('sends an email queued before the link existed without one, and invents nothing', async () => {
    const id = await queueEmail();
    await enqueue('email.queued.v1', id);
    await relay().tick();
    const sent = email.messages()[0]!;
    expect(sent.text).not.toContain('To stop receiving');
    expect(sent.unsubscribeUrl).toBeUndefined();
  });

  it('does not use a token that is not of the right shape', async () => {
    const id = await queueEmail({ token: 'not-a-token' });
    await enqueue('email.queued.v1', id);
    await relay().tick();
    const sent = email.messages()[0]!;
    expect(sent.text).not.toContain('not-a-token');
    expect(sent.unsubscribeUrl).toBeUndefined();
    expect((await rowOf(id)).status).toBe('sent');
  });

  it('sends nothing the second time the same event is delivered', async () => {
    const id = await queueEmail();
    await enqueue('email.queued.v1', id);
    await enqueue('email.queued.v1', id);
    const instance = relay();
    await instance.tick();
    await instance.tick();

    expect(email.messages()).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('sent');
    expect((await rowOf(id)).attempts).toBe(1);
  });

  it('puts the email on the record’s timeline in plain words, with no personal content', async () => {
    const id = await queueEmail({ body: 'Secret pricing for Mrs Sharma' });
    await enqueue('email.queued.v1', id);
    await relay().tick();
    await relay().tick();

    const events = await eventsFor(id);
    const sentEvent = events.find((event) => event.event_type === 'email.sent.v1')!;
    expect(sentEvent).toMatchObject({ object_type: 'contact', record_id: contactId });
    expect(Object.keys(sentEvent.payload)).toEqual(['emailId']);

    const timeline = await superuserPool.query<{ summary: string; detail: unknown }>(
      `select summary, detail from timeline_events where tenant_id = $1 and record_id = $2
         and event_type = 'email.sent.v1'`,
      [tenantId, contactId],
    );
    expect(timeline.rows.length).toBeGreaterThan(0);
    expect(timeline.rows[0]?.summary).toBe('Email sent');
    const everything = JSON.stringify([events, timeline.rows]);
    expect(everything).not.toContain('Secret pricing');
    expect(everything).not.toContain('sharma@customer.example');
    expect(everything).not.toContain('Your quote');
  });
});

describe('when the mail service says no', () => {
  it('tries a temporary failure again, and sends once it works', async () => {
    const id = await queueEmail();
    const eventId = await enqueue('email.queued.v1', id);
    const instance = relay();
    email.failNext({ retryable: true, status: 503 });
    await instance.tick();

    // Back in the queue, not failed, and the relay will deliver the event again after its backoff.
    expect(await rowOf(id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(email.messages()).toHaveLength(0);
    await superuserPool.query(`update outbox_events set available_at = now() where id = $1`, [
      eventId,
    ]);
    await instance.tick();

    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(email.messages()).toHaveLength(1);
  });

  it('closes a final refusal at once, with a code and no retry', async () => {
    const id = await queueEmail();
    await enqueue('email.queued.v1', id);
    const instance = relay();
    email.failNext({ retryable: false, status: 550 });
    await instance.tick();

    expect(await rowOf(id)).toMatchObject({ status: 'failed', failure_code: 'invalid_recipient' });
    const failed = (await eventsFor(id)).find((event) => event.event_type === 'email.failed.v1')!;
    expect(failed.payload).toEqual({ emailId: id, failureCode: 'invalid_recipient' });
    expect(email.messages()).toHaveLength(0);
  });

  it('closes an email the relay has given up on, so it is not queued for ever', async () => {
    const id = await queueEmail();
    await enqueue('email.queued.v1', id);
    const instance = relay({ maxAttempts: 1 });
    email.failNext({ retryable: true });
    await instance.tick();

    expect(await rowOf(id)).toMatchObject({
      status: 'failed',
      failure_code: 'provider_unavailable',
    });
  });

  it('does not send an email whose content an erasure has scrubbed', async () => {
    const id = await queueEmail({ erased: true });
    await enqueue('email.queued.v1', id);
    await relay().tick();

    expect(email.messages()).toHaveLength(0);
    expect(await rowOf(id)).toMatchObject({ status: 'failed', failure_code: 'rejected' });
  });
});

describe('the watchdog', () => {
  it('turns a message stuck in "sending" into "outcome unknown"', async () => {
    const id = await queueEmail({ status: 'sending' });
    await superuserPool.query(
      `update email_messages set sending_started_at = now() - interval '20 minutes' where id = $1`,
      [id],
    );
    await enqueue('email.watchdog_due.v1', id);
    await relay().tick();

    expect(await rowOf(id)).toMatchObject({ status: 'failed', failure_code: 'outcome_unknown' });
    expect(email.messages()).toHaveLength(0);
  });

  it('leaves a message that is only just being sent alone', async () => {
    const id = await queueEmail({ status: 'sending' });
    await superuserPool.query(
      `update email_messages set sending_started_at = now() where id = $1`,
      [id],
    );
    await enqueue('email.watchdog_due.v1', id);
    await relay().tick();
    expect((await rowOf(id)).status).toBe('sending');
  });

  it('queues a lost send again, and watches again', async () => {
    const id = await queueEmail();
    await superuserPool.query(
      `update email_messages
         set queued_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes'
       where id = $1`,
      [id],
    );
    await enqueue('email.watchdog_due.v1', id);
    await relay().tick();

    const events = await eventsFor(id);
    expect(events.filter((event) => event.event_type === 'email.queued.v1')).toHaveLength(1);
    expect(events.filter((event) => event.event_type === 'email.watchdog_due.v1')).toHaveLength(2);
    // And the fresh event sends it.
    await relay().tick();
    expect((await rowOf(id)).status).toBe('sent');
  });

  it('gives up on a message that has been queued for an hour', async () => {
    const id = await queueEmail();
    await superuserPool.query(
      `update email_messages set queued_at = now() - interval '2 hours' where id = $1`,
      [id],
    );
    await enqueue('email.watchdog_due.v1', id);
    await relay().tick();
    expect(await rowOf(id)).toMatchObject({
      status: 'failed',
      failure_code: 'provider_unavailable',
    });
  });

  it('does nothing for a message that is already settled', async () => {
    const id = await queueEmail({ status: 'sent' });
    await enqueue('email.watchdog_due.v1', id);
    await relay().tick();
    expect((await rowOf(id)).status).toBe('sent');
    expect(await eventsFor(id)).toHaveLength(1);
  });
});
