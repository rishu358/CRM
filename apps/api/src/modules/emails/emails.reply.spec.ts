import { randomUUID } from 'node:crypto';
import { REPLY_LOCAL_PATTERN } from '@crm/core';
import { verifyReplyToken } from '@crm/core/email-reply-address';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { replyVerifySecrets } from '../../common/unsubscribe-secrets.js';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Replies on the sending side and on the record (ADR-0077), through the real HTTP stack: every email queued while an
 * inbound domain is set carries a signed reply token that no answer ever shows, and a filed reply is read like any
 * other email, by those who may read the record and nobody else. The door that receives replies is in
 * `email-events.spec.ts`; the worker that files them is in `apps/worker`; the security suites for the routes are in
 * `emails.security.spec.ts`.
 */

interface Person {
  token: string;
  userId: string;
}
interface Email {
  id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  fromName: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string;
  body: string;
  attachmentCount: number;
  bodyShortened: boolean;
  senderMatchesRecipient: boolean | null;
  erased: boolean;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantA: string;
let adminA: Person;
let repA: Person;
let otherRepA: Person;
let readOnlyA: Person;
let contactA: string;
let tenantB: string;
let adminB: Person;

const call = (token: string, method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) =>
  request(harness, { method, url: `/api/v1${url}`, token, body });

async function fileReply(
  tenantId: string,
  contactId: string,
  options: {
    from?: string;
    body?: string;
    attachments?: number;
    shortened?: boolean;
    answers?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_messages
       (id, tenant_id, direction, status, source_object_type, source_record_id, contact_id, from_name,
        from_address, to_address, subject, body_text, message_id, provider_message_id, attachment_count,
        body_shortened, reply_to_email_id)
     values ($1, $2, 'inbound', 'received', 'contact', $3, $3, 'Sam Customer', $4, 'priya@company.example',
             'Re: Your quote', $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      contactId,
      options.from ?? 'sam@customer.example',
      options.body ?? 'Thanks, that works for us.',
      `<${id}@customer.example>`,
      `recv-${id}`,
      options.attachments ?? 0,
      options.shortened ?? false,
      options.answers ?? null,
    ],
  );
  await superuser.query(
    `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
     values ($1, $2, $3, 'contact', $4)`,
    [randomUUID(), tenantId, id, contactId],
  );
  return id;
}

const listFor = (token: string, contactId: string) =>
  call(token, 'GET', `/emails?objectType=contact&recordId=${contactId}`);

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, {
    EMAIL_OUTREACH_FROM: 'mail@send.example',
    EMAIL_INBOUND_DOMAIN: 'reply.example.com',
  });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Reply Traders' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Reply Rivals' })).tenantId;
  const rolesB = await harness.provision(tenantB);
  const make = async (tenantId: string, roleId: string) => {
    const user = await harness.fixtures.createUser(tenantId, roleId);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  adminA = await make(tenantA, rolesA.get('Admin')!);
  repA = await make(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = await make(tenantA, rolesA.get('Sales Rep')!);
  readOnlyA = await make(tenantA, rolesA.get('Read-only')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);
  contactA = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Replying',
    email: 'sam@customer.example',
  });
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes' where tenant_id = $1`,
    [tenantA],
  );
});

describe('the reply address a sent email carries', () => {
  const send = (token: string, subject: string) =>
    call(token, 'POST', '/emails', {
      objectType: 'contact',
      recordId: contactA,
      subject,
      body: 'Hello',
    });

  it('is signed for the email and stored on it, while an inbound domain is set', async () => {
    const sent = dataOf<Email>(await send(adminA.token, 'With a reply address'));
    const row = await superuser.query<{
      reply_token: string | null;
      unsubscribe_token: string | null;
    }>(`select reply_token, unsubscribe_token from email_messages where id = $1`, [sent.id]);
    const token = row.rows[0]?.reply_token ?? null;
    expect(token).not.toBeNull();
    expect(token).toMatch(REPLY_LOCAL_PATTERN);
    expect(verifyReplyToken(replyVerifySecrets(harness.env), token)).toBe(sent.id);
    // It is its own value, not the unsubscribe link's.
    expect(token).not.toBe(row.rows[0]?.unsubscribe_token);
  });

  it('gives each email its own address', async () => {
    const first = dataOf<Email>(await send(adminA.token, 'First'));
    const second = dataOf<Email>(await send(adminA.token, 'Second'));
    const rows = await superuser.query<{ reply_token: string }>(
      `select reply_token from email_messages where id = any($1::uuid[])`,
      [[first.id, second.id]],
    );
    expect(new Set(rows.rows.map((row) => row.reply_token)).size).toBe(2);
  });

  it('is in no answer the API gives, to the sender or to anyone', async () => {
    const sent = dataOf<Email>(await send(adminA.token, 'Not shown'));
    const row = await superuser.query<{ reply_token: string }>(
      `select reply_token from email_messages where id = $1`,
      [sent.id],
    );
    const token = row.rows[0]!.reply_token;
    const read = await call(adminA.token, 'GET', `/emails/${sent.id}`);
    const list = await listFor(adminA.token, contactA);
    expect(JSON.stringify([sent, read.body, list.body])).not.toContain(token);
  });

  it('cannot be chosen by a request: the address, the direction and the status are refused as unknown', async () => {
    for (const extra of [
      { replyToken: 'r.x' },
      { captureAddress: 'someone@reply.example.com' },
      { direction: 'inbound' },
      { status: 'received' },
    ]) {
      const response = await call(adminA.token, 'POST', '/emails', {
        objectType: 'contact',
        recordId: contactA,
        subject: 'Hello',
        body: 'Hi',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });
});

describe('a filed reply, read through the API', () => {
  it('is an inbound message with the sender as claimed, and says what was left out', async () => {
    const id = await fileReply(tenantA, contactA, { attachments: 2, shortened: true });
    const listed = dataOf<Email[]>(await listFor(adminA.token, contactA));
    const reply = listed.find((email) => email.id === id);
    expect(reply).toMatchObject({
      direction: 'inbound',
      status: 'received',
      fromName: 'Sam Customer',
      fromAddress: 'sam@customer.example',
      toAddress: 'priya@company.example',
      subject: 'Re: Your quote',
      body: 'Thanks, that works for us.',
      attachmentCount: 2,
      bodyShortened: true,
      erased: false,
    });
  });

  it('carries no sender address on an email we sent', async () => {
    const sent = dataOf<Email>(
      await call(adminA.token, 'POST', '/emails', {
        objectType: 'contact',
        recordId: contactA,
        subject: 'Outbound',
        body: 'Hi',
      }),
    );
    expect(sent.direction).toBe('outbound');
    expect(sent.fromAddress).toBeNull();
    expect(sent.attachmentCount).toBe(0);
    expect(sent.bodyShortened).toBe(false);
  });

  it('is read by the owner of the record and an administrator, and by a rep who cannot see the record not at all', async () => {
    const id = await fileReply(tenantA, contactA, {
      body: 'Only for those who may see this contact.',
    });
    for (const person of [repA, adminA]) {
      const listed = dataOf<Email[]>(await listFor(person.token, contactA));
      expect(
        listed.map((email) => email.id),
        person.userId,
      ).toContain(id);
    }
    // A reply on a record someone cannot see is a 404 for that person, never an empty list or a 403.
    const hidden = await listFor(otherRepA.token, contactA);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain('Only for those who may see');
  });

  it('is refused to a role with no right to read email, and to another company altogether', async () => {
    const id = await fileReply(tenantA, contactA);
    expect((await listFor(readOnlyA.token, contactA)).status).toBe(403);
    const other = await listFor(adminB.token, contactA);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain(id);
    expect((await call(adminB.token, 'GET', `/emails/${id}`)).status).toBe(404);
  });

  it('cannot be created, changed or marked through the API: its routes only read', async () => {
    const id = await fileReply(tenantA, contactA);
    for (const [method, url] of [
      ['POST', `/emails/${id}/retry`],
      ['POST', `/emails/${id}`],
    ] as const) {
      const response = await call(adminA.token, method, url);
      expect([404, 405, 409, 422], `${method} ${url}`).toContain(response.status);
    }
    const row = await superuser.query<{ status: string; direction: string }>(
      `select status, direction from email_messages where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'received', direction: 'inbound' });
  });
});

describe('whether a reply came from the address we wrote to', () => {
  const sentTo = async (address: string | null): Promise<string> => {
    const sent = dataOf<Email>(
      await call(adminA.token, 'POST', '/emails', {
        objectType: 'contact',
        recordId: contactA,
        subject: `To ${address ?? 'nobody'}`,
        body: 'Hi',
      }),
    );
    if (address !== null) {
      await superuser.query(`update email_messages set to_address = $2 where id = $1`, [
        sent.id,
        address,
      ]);
    }
    return sent.id;
  };
  const claimFor = async (replyId: string) =>
    dataOf<Email[]>(await listFor(adminA.token, contactA)).find((email) => email.id === replyId)
      ?.senderMatchesRecipient;

  it('is true when the sender is the address the email was written to, whatever the case', async () => {
    const original = await sentTo('sam@customer.example');
    const reply = await fileReply(tenantA, contactA, {
      from: 'sam@customer.example',
      answers: original,
    });
    expect(await claimFor(reply)).toBe(true);
    const upper = await sentTo('Sam@Customer.Example');
    const second = await fileReply(tenantA, contactA, {
      from: 'sam@customer.example',
      answers: upper,
    });
    expect(await claimFor(second)).toBe(true);
  });

  it('is false when the reply comes from another address, which is what an assistant or a forward looks like', async () => {
    const original = await sentTo('sam@customer.example');
    const reply = await fileReply(tenantA, contactA, {
      from: 'someone-else@elsewhere.example',
      answers: original,
    });
    expect(await claimFor(reply)).toBe(false);
  });

  it('is not known when the email it answers is gone or has been erased, and for anything we sent', async () => {
    const original = await sentTo('sam@customer.example');
    const reply = await fileReply(tenantA, contactA, { answers: original });
    await superuser.query(
      `update email_messages set to_address = null, erased_at = now(), subject = '', body_text = '' where id = $1`,
      [original],
    );
    expect(await claimFor(reply)).toBeNull();

    const standalone = await fileReply(tenantA, contactA);
    expect(await claimFor(standalone)).toBeNull();

    const sent = dataOf<Email>(
      await call(adminA.token, 'POST', '/emails', {
        objectType: 'contact',
        recordId: contactA,
        subject: 'Out',
        body: 'Hi',
      }),
    );
    expect(sent.senderMatchesRecipient).toBeNull();
  });

  it('is not known for a reply that has itself been erased, and shows no address then', async () => {
    const original = await sentTo('sam@customer.example');
    const reply = await fileReply(tenantA, contactA, { answers: original });
    await superuser.query(
      `update email_messages set erased_at = now(), from_address = '', from_name = 'Erased', subject = '', body_text = '', to_address = null where id = $1`,
      [reply],
    );
    const shown = dataOf<Email[]>(await listFor(adminA.token, contactA)).find(
      (email) => email.id === reply,
    )!;
    expect(shown).toMatchObject({ senderMatchesRecipient: null, fromAddress: null, erased: true });
  });
});

describe('whether replies are filed, for Settings > Email', () => {
  const settingsOf = async (token: string) =>
    dataOf<{ replyCapture: { state: string; domain: string | null } }>(
      await call(token, 'GET', '/email-settings'),
    ).replyCapture;

  it('says unsupported where an inbound domain is set but the provider cannot receive (this stack sends to memory)', async () => {
    expect(await settingsOf(adminA.token)).toEqual({
      state: 'unsupported',
      domain: 'reply.example.com',
    });
  });

  it('says on where the provider is one that receives, and the domain it receives at', async () => {
    const resend = await startApiHarness(inject('dbUrls'), {
      EMAIL_OUTREACH_FROM: 'mail@send.example',
      EMAIL_INBOUND_DOMAIN: 'Reply.Example.com',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: `re_${'a'.repeat(24)}`,
    });
    try {
      const token = await resend.signIn(adminA.userId, tenantA);
      const response = await request(resend, {
        method: 'GET',
        url: '/api/v1/email-settings',
        token,
      });
      expect(dataOf<{ replyCapture: unknown }>(response).replyCapture).toEqual({
        state: 'on',
        domain: 'reply.example.com',
      });
    } finally {
      await resend.close();
    }
  });

  it('says off where no inbound domain is set, and shows no domain', async () => {
    const off = await startApiHarness(inject('dbUrls'), {
      EMAIL_OUTREACH_FROM: 'mail@send.example',
    });
    try {
      const token = await off.signIn(adminA.userId, tenantA);
      const response = await request(off, { method: 'GET', url: '/api/v1/email-settings', token });
      expect(dataOf<{ replyCapture: unknown }>(response).replyCapture).toEqual({
        state: 'off',
        domain: null,
      });
    } finally {
      await off.close();
    }
  });

  it('is the installation’s setting, so every company sees the same answer', async () => {
    expect((await call(adminA.token, 'GET', '/email-settings')).status).toBe(200);
    expect((await call(adminB.token, 'GET', '/email-settings')).status).toBe(200);
    expect(await settingsOf(adminB.token)).toEqual({
      state: 'unsupported',
      domain: 'reply.example.com',
    });
  });
});
