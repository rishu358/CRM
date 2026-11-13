import { EMAIL_REPLY_LIMITS, NO_PLAIN_TEXT, newId, type ReceivedEmail } from '@crm/core';
import { createDbClient, sql, withoutTenant, type DbClient } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryInboundEmailProvider } from '../email/provider.js';
import { OutboxRelay } from '../relay.js';
import { fileReply } from './email-replies.js';
import { projectTimeline } from './timeline.js';

/**
 * What the worker does with a customer's reply that the public door has accepted (ADR-0077), driven through the
 * real relay: it is fetched and filed once on the records the sent email is linked to, as an unverified inbound
 * message, shortened to fit and never as HTML; a repeat, a loop, a stranger's flood and a message with no usable
 * sender are all dropped; and nothing written holds the address, the subject or the words.
 */
const logger = pino({ level: 'silent' });
const OWN = 'mail@send.example';

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let inbound: MemoryInboundEmailProvider;
let tenantId: string;
let otherTenantId: string;
let userId: string;
let contactId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);
  tenantId = (await fixtures.createTenant({ name: 'Replies Worker' })).tenantId;
  otherTenantId = (await fixtures.createTenant({ name: 'Replies Worker Rival' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Rep');
  userId = (await fixtures.createUser(tenantId, roleId)).userId;
  contactId = await fixtures.createContact(tenantId, {
    ownerId: userId,
    lastName: 'Replying',
    email: 'sam@customer.example',
  });
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

function relay(): OutboxRelay {
  inbound = new MemoryInboundEmailProvider();
  return new OutboxRelay(worker.db, { logger, batchSize: 200 })
    .on(
      'email.reply_received.v1',
      fileReply({ db: worker.db, inbound, logger, ownAddresses: [OWN] }),
    )
    .on('email.replied.v1', projectTimeline);
}

const received = (change: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  fromAddress: 'Sam@Customer.Example',
  fromName: 'Sam Customer',
  subject: 'Re: Your quote',
  text: 'Thanks, that works for us.',
  messageId: `<${newId()}@customer.example>`,
  attachmentCount: 0,
  ...change,
});

interface Sent {
  id: string;
  recordId: string;
}

async function sentEmail(
  options: { tenant?: string; erased?: boolean; links?: [string, string][] } = {},
): Promise<Sent> {
  const tenant = options.tenant ?? tenantId;
  const id = newId();
  const recordId = tenant === tenantId ? contactId : newId();
  await superuserPool.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, contact_id, from_name, from_address,
        reply_to, to_address, subject, body_text, message_id, sent_at, erased_at, created_by)
     values ($1, $2, 'sent', 'contact', $3, $3, 'Acme', $4, 'priya@company.example', $5, 'Your quote',
             'Body', $6, now(), $7, $8)`,
    [
      id,
      tenant,
      recordId,
      OWN,
      options.erased === true ? null : 'sam@customer.example',
      `<${id}@send.example>`,
      options.erased === true ? new Date() : null,
      tenant === tenantId ? userId : null,
    ],
  );
  for (const [objectType, linked] of options.links ?? [['contact', recordId]]) {
    await superuserPool.query(
      `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
       values ($1, $2, $3, $4, $5)`,
      [newId(), tenant, id, objectType, linked],
    );
  }
  return { id, recordId };
}

async function fire(emailId: string, providerEmailId: string, tenant = tenantId): Promise<string> {
  const id = newId();
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${id}, ${tenant}, 'email.reply_received.v1', 'email_message', ${emailId},
              ${JSON.stringify({ emailId, providerEmailId, at: new Date().toISOString() })}::jsonb, now())
    `),
  );
  return id;
}

interface Filed {
  id: string;
  from_name: string;
  from_address: string;
  to_address: string | null;
  subject: string;
  body_text: string;
  message_id: string;
  provider_message_id: string;
  reply_to_email_id: string | null;
  contact_id: string | null;
  source_record_id: string;
  attachment_count: number;
  body_shortened: boolean;
  created_by: string | null;
  status: string;
  direction: string;
}

const repliesTo = async (emailId: string) =>
  (
    await superuserPool.query<Filed>(
      `select * from email_messages where reply_to_email_id = $1 order by id`,
      [emailId],
    )
  ).rows;

const eventsAbout = async (id: string) =>
  (
    await superuserPool.query<{ object_type: string; record_id: string; payload: unknown }>(
      `select object_type, record_id, payload from outbox_events
       where tenant_id = $1 and event_type = 'email.replied.v1' and payload ->> 'repliedToId' = $2`,
      [tenantId, id],
    )
  ).rows;

describe('filing a reply', () => {
  it('fetches it once and files it as an inbound message on the records the sent email is on, unverified, with ids only in what it queues', async () => {
    const dealId = newId();
    const sent = await sentEmail({
      links: [
        ['contact', contactId],
        ['deal', dealId],
      ],
    });
    const instance = relay();
    inbound.add('recv-1', received({ attachmentCount: 2 }));
    await fire(sent.id, 'recv-1');
    await instance.tick();

    const [reply, ...rest] = await repliesTo(sent.id);
    expect(rest).toHaveLength(0);
    expect(reply).toMatchObject({
      direction: 'inbound',
      status: 'received',
      from_name: 'Sam Customer',
      from_address: 'sam@customer.example',
      // The row needs a recipient: the address the sent email asked answers to go to, never ours.
      to_address: 'priya@company.example',
      subject: 'Re: Your quote',
      body_text: 'Thanks, that works for us.',
      provider_message_id: 'recv-1',
      reply_to_email_id: sent.id,
      contact_id: contactId,
      source_record_id: contactId,
      attachment_count: 2,
      body_shortened: false,
      created_by: null,
    });

    const links = await superuserPool.query<{ object_type: string; record_id: string }>(
      `select object_type, record_id from email_message_links where email_message_id = $1 order by object_type`,
      [reply!.id],
    );
    expect(links.rows).toEqual([
      { object_type: 'contact', record_id: contactId },
      { object_type: 'deal', record_id: dealId },
    ]);

    // One line on the timeline of the record it was sent from, and ids only anywhere.
    const lines = await eventsAbout(sent.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ object_type: 'contact', record_id: contactId });
    const audit = await superuserPool.query(
      `select actor_id, action, changes from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantId, reply!.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: null, action: 'create' });
    const timeline = await superuserPool.query(
      `select * from timeline_events where tenant_id = $1 and record_id = $2 and event_type = 'email.replied.v1'`,
      [tenantId, contactId],
    );
    const everything = JSON.stringify([lines, audit.rows, timeline.rows]);
    for (const secret of [
      'sam@customer.example',
      'Re: Your quote',
      'Thanks, that works',
      'Sam Customer',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('files nothing the second time the same event arrives, and does not fetch again', async () => {
    const sent = await sentEmail();
    const instance = relay();
    inbound.add('recv-2', received());
    await fire(sent.id, 'recv-2');
    await fire(sent.id, 'recv-2');
    await instance.tick();
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(1);
    expect(inbound.fetchCount()).toBe(1);
  });

  it('files one message once even when it reached two of our addresses under two provider ids', async () => {
    const sent = await sentEmail();
    const instance = relay();
    const messageId = `<${newId()}@customer.example>`;
    inbound.add('recv-3a', received({ messageId }));
    inbound.add('recv-3b', received({ messageId }));
    await fire(sent.id, 'recv-3a');
    await fire(sent.id, 'recv-3b');
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(1);
  });

  it('stores what fits the log: a long name, subject and body are cut, and the body says it was', async () => {
    const sent = await sentEmail();
    const instance = relay();
    inbound.add(
      'recv-4',
      received({
        fromName: `N${'x'.repeat(200)}`,
        subject: `S${'y'.repeat(400)}`,
        text: 'z'.repeat(12_000),
      }),
    );
    await fire(sent.id, 'recv-4');
    await instance.tick();
    const [reply] = await repliesTo(sent.id);
    expect(reply!.from_name).toHaveLength(80);
    expect(reply!.subject).toHaveLength(200);
    expect(reply!.body_text).toHaveLength(10_000);
    expect(reply!.body_shortened).toBe(true);
  });

  it('says so when the message had no plain-text part, and stores no markup of any kind', async () => {
    const sent = await sentEmail();
    const instance = relay();
    inbound.add('recv-5', received({ text: null }));
    await fire(sent.id, 'recv-5');
    await instance.tick();
    expect((await repliesTo(sent.id))[0]!.body_text).toBe(NO_PLAIN_TEXT);

    const second = await sentEmail();
    inbound.add('recv-5b', received({ text: '<script>alert(1)</script><b>bold</b>' }));
    await fire(second.id, 'recv-5b');
    await instance.tick();
    // Kept as the characters it is: it is drawn as text, never as HTML.
    expect((await repliesTo(second.id))[0]!.body_text).toBe('<script>alert(1)</script><b>bold</b>');
  });
});

describe('what is dropped', () => {
  const nothing = async (sent: Sent, providerEmailId: string, change: Partial<ReceivedEmail>) => {
    const instance = relay();
    inbound.add(providerEmailId, received(change));
    await fire(sent.id, providerEmailId);
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(0);
    expect(await eventsAbout(sent.id)).toHaveLength(0);
  };

  it('a message that claims to be from one of our own sending addresses: a loop', async () => {
    await nothing(await sentEmail(), 'recv-6', { fromAddress: OWN.toUpperCase() });
  });

  it('a message with no usable sender', async () => {
    const sent = await sentEmail();
    await nothing(sent, 'recv-7a', { fromAddress: 'not an address' });
    await nothing(sent, 'recv-7b', { fromAddress: 'a@b.example\r\nBcc: x@evil.example' });
  });

  it('a reply to an email that is gone, or whose recipient an erasure has scrubbed, without fetching anything', async () => {
    const instance = relay();
    inbound.add('recv-8', received());
    await fire(newId(), 'recv-8');
    const erased = await sentEmail({ erased: true });
    await fire(erased.id, 'recv-8');
    await instance.tick();
    expect(await repliesTo(erased.id)).toHaveLength(0);
    expect(inbound.fetchCount()).toBe(0);
  });

  it('a permanent failure to fetch: dropped, not tried again', async () => {
    const sent = await sentEmail();
    const instance = relay();
    inbound.failNext({ retryable: false, status: 403 });
    inbound.add('recv-9', received());
    await fire(sent.id, 'recv-9');
    await instance.tick();
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(0);
    expect(inbound.fetchCount()).toBe(1);
  });

  it('a message the provider does not have is not filed, and is not an error to anyone', async () => {
    const sent = await sentEmail();
    const instance = relay();
    await fire(sent.id, 'recv-never-added');
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(0);
  });
});

describe('a temporary failure', () => {
  it('is tried again by the relay with its backoff, and files the reply once it works', async () => {
    const sent = await sentEmail();
    const instance = relay();
    inbound.add('recv-10', received());
    inbound.failNext({ retryable: true, status: 503 });
    const eventId = await fire(sent.id, 'recv-10');
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(0);

    await superuserPool.query(`update outbox_events set available_at = now() where id = $1`, [
      eventId,
    ]);
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(1);
    expect(inbound.fetchCount()).toBe(2);
  });
});

describe('the limits', () => {
  const addReplies = async (tenant: string, emailId: string | null, count: number) => {
    await superuserPool.query(
      `insert into email_messages
         (id, tenant_id, direction, status, source_object_type, source_record_id, from_name, from_address,
          to_address, subject, body_text, message_id, provider_message_id, reply_to_email_id)
       select gen_random_uuid(), $1, 'inbound', 'received', 'contact', gen_random_uuid(), 'x', 'x@y.example',
              'priya@company.example', 's', 'b', '<' || gen_random_uuid() || '@limit.example>',
              'limit-' || gen_random_uuid(), $2
       from generate_series(1, $3)`,
      [tenant, emailId, count],
    );
  };

  it('stops at the most replies one sent email may have, and fetches nothing beyond it', async () => {
    const sent = await sentEmail();
    await addReplies(tenantId, sent.id, EMAIL_REPLY_LIMITS.perEmail);
    const instance = relay();
    inbound.add('recv-11', received());
    await fire(sent.id, 'recv-11');
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(EMAIL_REPLY_LIMITS.perEmail);
    expect(inbound.fetchCount()).toBe(0);
  });

  it('stops at the most replies a company may file in a day, for every email of that company and no other', async () => {
    const busy = (await fixtures.createTenant({ name: 'Replies Busy' })).tenantId;
    const sent = await sentEmail({ tenant: busy });
    await addReplies(busy, null, EMAIL_REPLY_LIMITS.perCompanyPerDay);
    const instance = relay();
    inbound.add('recv-12', received());
    await fire(sent.id, 'recv-12', busy);
    await instance.tick();
    expect(await repliesTo(sent.id)).toHaveLength(0);
    expect(inbound.fetchCount()).toBe(0);

    // Another company is not held back by it.
    const calm = await sentEmail();
    inbound.add('recv-12b', received());
    await fire(calm.id, 'recv-12b');
    await instance.tick();
    expect(await repliesTo(calm.id)).toHaveLength(1);
  });
});

describe('company isolation', () => {
  it('never files a reply under another company, whatever an event names', async () => {
    const mine = await sentEmail();
    const instance = relay();
    inbound.add('recv-13', received());
    // An event in the rival's company that names this company's email: it is not found there.
    await fire(mine.id, 'recv-13', otherTenantId);
    await instance.tick();
    expect(await repliesTo(mine.id)).toHaveLength(0);
    const filed = await superuserPool.query(
      `select count(*)::int as n from email_messages where tenant_id = $1 and direction = 'inbound'`,
      [otherTenantId],
    );
    expect(filed.rows[0]).toEqual({ n: 0 });
    expect(inbound.fetchCount()).toBe(0);
  });
});
