import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Email sent from a record, through the real HTTP stack (ADR-0073): what a person can send, to whom,
 * what is written down, and what is refused. The security suites are in `emails.security.spec.ts`; the
 * worker's side (the actual sending) is in `apps/worker/src/handlers/email.spec.ts`. The API never
 * sends, which one test below asserts.
 */

interface Person {
  token: string;
  userId: string;
}
interface Email {
  id: string;
  status: string;
  fromName: string;
  toAddress: string | null;
  replyTo: string | null;
  subject: string;
  body: string;
  failureCode: string | null;
  contactId: string | null;
  sentById: string | null;
  sentByName: string | null;
  retryOfId: string | null;
  retriedById: string | null;
  erased: boolean;
}
interface Settings {
  fromName: string;
  replyTo: string | null;
  footerText: string | null;
  version: number | null;
  sendingAddress: string | null;
  defaultFromName: string;
  usage: {
    sentToday: number;
    limitPerUser: number;
    tenantSentToday: number;
    limitPerTenant: number;
  };
}

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantId: string;
let admin: Person;
let rep: Person;
let repEmail: string;
let contactId: string;
let noAddressContactId: string;
let withdrawnContactId: string;
let leadId: string;
let dealId: string;

const send = (token: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  request(harness, { method: 'POST', url: '/api/v1/emails', token, body, headers });

const ok = (subject = 'Your quote') => ({
  objectType: 'contact',
  recordId: contactId,
  subject,
  body: 'Hello Sharma,\n\nPlease find the quote.',
});

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { EMAIL_OUTREACH_FROM: 'mail@send.example' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantId = (await harness.fixtures.createTenant({ name: 'Sharma Traders' })).tenantId;
  const roles = await harness.provision(tenantId);
  const make = async (roleName: string, name: string, email?: string) => {
    const user = await harness.fixtures.createUser(tenantId, roles.get(roleName)!, {
      name,
      ...(email === undefined ? {} : { email }),
    });
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  admin = await make('Admin', 'Asha Admin');
  repEmail = 'priya.rep@company.example';
  rep = await make('Sales Rep', 'Priya Rep', repEmail);

  contactId = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    firstName: 'Anil',
    lastName: 'Sharma',
    email: 'anil@customer.example',
  });
  noAddressContactId = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    lastName: 'Nomail',
  });
  withdrawnContactId = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    lastName: 'Withdrawn',
    email: 'withdrawn@customer.example',
  });
  await superuser.query(`update contacts set consent = $2::jsonb where id = $1`, [
    withdrawnContactId,
    JSON.stringify({ email: { status: 'withdrawn', source: 'reply', at: '2026-10-01T00:00:00Z' } }),
  ]);
  leadId = await harness.fixtures.createLead(tenantId, {
    ownerId: rep.userId,
    lastName: 'Verma',
    email: 'verma@prospect.example',
  });
  const pipeline = (await harness.fixtures.pipelinesFor(tenantId))[0]!;
  dealId = await harness.fixtures.createDeal(tenantId, {
    ownerId: rep.userId,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0]!.id,
    name: 'Big order',
    primaryContactId: contactId,
  });
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

// The limit of ten sends a minute is real and is tested on its own below. Everything else in this file
// sends a handful of emails as the same person within seconds, so after each test the company's
// messages are moved back in time, out of the minute that limit looks at. The daily counts are not
// touched: the company is young, a person may send 20 a day, and this file sends about eleven.
afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes' where tenant_id = $1`,
    [tenantId],
  );
});

describe('sending', () => {
  it('queues one email, answers 202 at once, and sends nothing itself', async () => {
    const before = harness.emails.messages().length;
    const response = await send(rep.token, ok());
    expect(response.status).toBe(202);
    const email = dataOf<Email>(response);
    expect(email).toMatchObject({
      status: 'queued',
      toAddress: 'anil@customer.example',
      subject: 'Your quote',
      fromName: 'Sharma Traders',
      replyTo: repEmail,
      contactId,
      sentById: rep.userId,
      sentByName: 'Priya Rep',
      retryOfId: null,
      retriedById: null,
      erased: false,
    });
    // The API's own mail provider saw nothing: sending is the worker's, from the outbox.
    expect(harness.emails.messages()).toHaveLength(before);
  });

  it('stores the message with our own Message-ID, the outreach address and one link', async () => {
    const email = dataOf<Email>(await send(rep.token, ok('Stored')));
    const row = (
      await superuser.query<{
        from_address: string;
        message_id: string;
        status: string;
        attempts: number;
        source_object_type: string;
        source_record_id: string;
      }>(
        `select from_address, message_id, status, attempts, source_object_type, source_record_id
         from email_messages where id = $1`,
        [email.id],
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      from_address: 'mail@send.example',
      status: 'queued',
      attempts: 0,
      source_object_type: 'contact',
      source_record_id: contactId,
    });
    expect(row.message_id).toBe(`<${email.id}@send.example>`);
    const links = (
      await superuser.query(
        `select object_type, record_id from email_message_links where email_message_id = $1`,
        [email.id],
      )
    ).rows;
    expect(links).toEqual([{ object_type: 'contact', record_id: contactId }]);
  });

  it('writes an audit entry and events that carry ids and words, never the person’s content', async () => {
    const subject = 'Secret subject for audit';
    const email = dataOf<Email>(
      await send(rep.token, { ...ok(subject), body: 'Secret body text' }),
    );

    const audit = (await harness.fixtures.auditEntries(tenantId, 'email_message')).find(
      (entry) => entry.recordId === email.id,
    );
    expect(audit?.action).toBe('create');

    const events = (
      await superuser.query<{ event_type: string; later: boolean }>(
        `select event_type, available_at > now() + interval '5 minutes' as later
         from outbox_events where tenant_id = $1 and record_id = $2 order by event_type`,
        [tenantId, email.id],
      )
    ).rows;
    expect(events.map((event) => event.event_type)).toEqual([
      'email.queued.v1',
      'email.watchdog_due.v1',
    ]);
    // The dead-man's switch is dated ten minutes ahead, so nothing polls.
    expect(events[1]?.later).toBe(true);

    const everything = JSON.stringify([audit, events]);
    for (const secret of [
      subject,
      'Secret body text',
      'anil@customer.example',
      'customer.example',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('sends to a lead from the lead', async () => {
    const email = dataOf<Email>(
      await send(rep.token, { objectType: 'lead', recordId: leadId, subject: 'Hi', body: 'Hello' }),
    );
    expect(email).toMatchObject({ toAddress: 'verma@prospect.example', contactId: null });
  });

  it('sends from a deal to one of its own contacts, and files it on both', async () => {
    const response = await send(rep.token, {
      objectType: 'deal',
      recordId: dealId,
      contactId,
      subject: 'About the order',
      body: 'Hello',
    });
    const email = dataOf<Email>(response);
    expect(email).toMatchObject({ toAddress: 'anil@customer.example', contactId });
    const links = (
      await superuser.query<{ object_type: string }>(
        `select object_type from email_message_links where email_message_id = $1 order by object_type`,
        [email.id],
      )
    ).rows.map((row) => row.object_type);
    expect(links).toEqual(['contact', 'deal']);
  });

  it('refuses a contact who is not on the deal, and a deal with no contact named', async () => {
    const stranger = await send(rep.token, {
      objectType: 'deal',
      recordId: dealId,
      contactId: noAddressContactId,
      subject: 'x',
      body: 'x',
    });
    expect(stranger.status).toBe(404);
    const missing = await send(rep.token, {
      objectType: 'deal',
      recordId: dealId,
      subject: 'x',
      body: 'x',
    });
    expect(missing.status).toBe(422);
    const extra = await send(rep.token, { ...ok(), contactId });
    expect(extra.status).toBe(422);
  });

  it('refuses a record with no email address', async () => {
    const response = await send(rep.token, { ...ok(), recordId: noAddressContactId });
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('NO_EMAIL_ADDRESS');
  });

  it('refuses a person who has withdrawn consent, and says so before the dialog is filled in', async () => {
    const response = await send(rep.token, { ...ok(), recordId: withdrawnContactId });
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('CONSENT_WITHDRAWN');

    const context = dataOf<{ consent: string; to: string }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/emails/context?objectType=contact&recordId=${withdrawnContactId}`,
        token: rep.token,
      }),
    );
    expect(context.consent).toBe('withdrawn');
  });

  it('refuses a subject that spans lines, an empty body and a body that is too long', async () => {
    for (const body of [
      { ...ok('Quote\r\nBcc: someone@evil.example') },
      { ...ok(), body: '   ' },
      { ...ok(), body: 'x'.repeat(10_001) },
      { ...ok('x'.repeat(201)) },
      { ...ok(''), subject: '' },
    ]) {
      expect((await send(rep.token, body)).status).toBe(422);
    }
  });

  it('refuses a request that names a recipient, a sender or a status of its own', async () => {
    for (const extra of [
      { to: 'someone@evil.example' },
      { from: 'ceo@bank.example' },
      { replyTo: 'x@evil.example' },
      { status: 'sent' },
      { fromName: 'The Bank' },
    ]) {
      const response = await send(rep.token, { ...ok(), ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('is idempotent: the same key queues one email and gives the same answer', async () => {
    const headers = { 'idempotency-key': `email-${Date.now()}-a` };
    const first = dataOf<Email>(await send(rep.token, ok('Once'), headers));
    const second = dataOf<Email>(await send(rep.token, ok('Once'), headers));
    expect(second.id).toBe(first.id);
    const count = await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_messages where tenant_id = $1 and subject = 'Once'`,
      [tenantId],
    );
    expect(count.rows[0]?.n).toBe(1);

    const reused = await send(rep.token, ok('Different'), headers);
    expect(reused.status).toBe(409);
  });
});

describe('the dialog’s context', () => {
  it('says who it goes to, as whom, and where a reply goes, before anything is typed', async () => {
    const context = dataOf<Record<string, unknown>>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/emails/context?objectType=contact&recordId=${contactId}`,
        token: rep.token,
      }),
    );
    expect(context).toMatchObject({
      to: 'anil@customer.example',
      toName: 'Anil Sharma',
      consent: 'none',
      fromName: 'Sharma Traders',
      replyTo: repEmail,
    });
    expect(context['usage']).toMatchObject({ limitPerUser: 20, limitPerTenant: 100 });
  });

  it('gives no address, with no word about why, for a record that has none', async () => {
    const context = dataOf<{ to: string | null }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/emails/context?objectType=contact&recordId=${noAddressContactId}`,
        token: rep.token,
      }),
    );
    expect(context.to).toBeNull();
  });
});

describe('reading the log', () => {
  it('lists a record’s emails newest first, in pages', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Paging Traders' })).tenantId;
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Admin')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Pages',
      email: 'pages@customer.example',
    });
    for (const subject of ['One', 'Two', 'Three']) {
      dataOf<Email>(
        await send(token, { objectType: 'contact', recordId: record, subject, body: 'b' }),
      );
    }

    const url = (cursor?: string) =>
      `/api/v1/emails?objectType=contact&recordId=${record}&limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const first = await request(harness, { method: 'GET', url: url(), token });
    expect(first.status).toBe(200);
    const firstPage = first.body['data'] as Email[];
    const firstMeta = first.body['meta'] as { hasMore: boolean; nextCursor: string | null };
    expect(firstPage.map((email) => email.subject)).toEqual(['Three', 'Two']);
    expect(firstMeta.hasMore).toBe(true);

    const second = await request(harness, {
      method: 'GET',
      url: url(firstMeta.nextCursor!),
      token,
    });
    const secondPage = second.body['data'] as Email[];
    expect(secondPage.map((email) => email.subject)).toEqual(['One']);
    expect((second.body['meta'] as { hasMore: boolean }).hasMore).toBe(false);

    const bad = await request(harness, { method: 'GET', url: url('not-a-cursor'), token });
    expect(bad.status).toBe(422);
  });

  it('lets a colleague who can see the record read the whole team’s emails on it', async () => {
    const email = dataOf<Email>(await send(rep.token, ok('For the team')));
    const asAdmin = await request(harness, {
      method: 'GET',
      url: `/api/v1/emails?objectType=contact&recordId=${contactId}`,
      token: admin.token,
    });
    expect((asAdmin.body['data'] as Email[]).map((e) => e.id)).toContain(email.id);
    const one = dataOf<Email>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/emails/${email.id}`,
        token: admin.token,
      }),
    );
    expect(one.sentByName).toBe('Priya Rep');
  });
});

describe('trying a failed email again', () => {
  const failed = async () => {
    const original = dataOf<Email>(await send(rep.token, ok(`Will fail ${Math.random()}`)));
    await superuser.query(
      `update email_messages set status = 'failed', failure_code = 'provider_unavailable', failed_at = now()
       where id = $1`,
      [original.id],
    );
    return original;
  };

  it('queues a new email with the same words, and keeps the failed one as it was', async () => {
    const original = await failed();
    const retried = dataOf<Email>(
      await request(harness, {
        method: 'POST',
        url: `/api/v1/emails/${original.id}/retry`,
        token: rep.token,
      }),
    );
    expect(retried).toMatchObject({
      status: 'queued',
      subject: original.subject,
      body: original.body,
      retryOfId: original.id,
    });
    expect(retried.id).not.toBe(original.id);

    const again = await request(harness, {
      method: 'GET',
      url: `/api/v1/emails/${original.id}`,
      token: rep.token,
    });
    expect(dataOf<Email>(again)).toMatchObject({ status: 'failed', retriedById: retried.id });

    // A second retry of the same one is a 409, not a second email.
    const second = await request(harness, {
      method: 'POST',
      url: `/api/v1/emails/${original.id}/retry`,
      token: rep.token,
    });
    expect(second.status).toBe(409);
  });

  it('will not retry an email that did not fail', async () => {
    const queued = dataOf<Email>(await send(rep.token, ok('Fine')));
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/emails/${queued.id}/retry`,
      token: rep.token,
    });
    expect(response.status).toBe(409);
  });
});

describe('the company’s sender', () => {
  it('starts as the company’s own name, and the first save needs no version', async () => {
    const initial = dataOf<Settings>(
      await request(harness, { method: 'GET', url: '/api/v1/email-settings', token: admin.token }),
    );
    expect(initial).toMatchObject({
      fromName: 'Sharma Traders',
      replyTo: null,
      version: null,
      sendingAddress: 'mail@send.example',
    });

    const saved = await request(harness, {
      method: 'PATCH',
      url: '/api/v1/email-settings',
      token: admin.token,
      body: {
        fromName: 'Sharma & Sons, Pune',
        replyTo: 'sales@sharma.example',
        footerText: 'Sharma & Sons, 12 Market Road, Pune',
      },
    });
    expect(saved.status).toBe(200);
    expect(dataOf<Settings>(saved)).toMatchObject({
      fromName: 'Sharma & Sons, Pune',
      replyTo: 'sales@sharma.example',
      version: 1,
    });

    // A second save without the version it read is a conflict, with it it works.
    const stale = await request(harness, {
      method: 'PATCH',
      url: '/api/v1/email-settings',
      token: admin.token,
      body: { fromName: 'Other', replyTo: null, footerText: null },
    });
    expect(stale.status).toBe(409);
    const again = await request(harness, {
      method: 'PATCH',
      url: '/api/v1/email-settings',
      token: admin.token,
      body: {
        fromName: 'Sharma & Sons, Pune',
        replyTo: 'sales@sharma.example',
        footerText: null,
        version: 1,
      },
    });
    expect(dataOf<Settings>(again).version).toBe(2);
  });

  it('is used by the next email: the saved name, the company’s reply address', async () => {
    const email = dataOf<Email>(await send(rep.token, ok('After settings')));
    expect(email).toMatchObject({
      fromName: 'Sharma & Sons, Pune',
      replyTo: 'sales@sharma.example',
    });
    const changes = JSON.stringify(
      await harness.fixtures.auditEntries(tenantId, 'email_sender_config'),
    );
    expect(changes).toContain('fromName');
  });

  it('refuses a name that could pass for an address, and a reply address that is not one', async () => {
    const attempt = (body: Record<string, unknown>) =>
      request(harness, {
        method: 'PATCH',
        url: '/api/v1/email-settings',
        token: admin.token,
        body: { fromName: 'Fine', replyTo: null, footerText: null, version: 2, ...body },
      });
    for (const body of [
      { fromName: 'Bank <ceo@bank.example>' },
      { fromName: 'ceo@bank.example' },
      { fromName: 'Line\r\nBcc: x@y.example' },
      { fromName: '' },
      { replyTo: 'Sales <sales@sharma.example>' },
      { replyTo: 'a@b.example, c@d.example' },
      { footerText: 'x'.repeat(501) },
      { sendingAddress: 'ceo@bank.example' },
    ]) {
      expect((await attempt(body)).status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('the daily limits', () => {
  const todayInIndia = async () =>
    (
      await superuser.query<{ d: string }>(
        `select (now() at time zone 'Asia/Kolkata')::date::text as d`,
      )
    ).rows[0]!.d;

  it('stops a person at their daily limit with a 429 that says when it resets', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Cap Traders' })).tenantId;
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Sales Rep')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Cap',
      email: 'cap@customer.example',
    });
    await superuser.query(
      `insert into email_daily_counts (tenant_id, user_id, day, sent) values ($1, $2, $3::date, 20)`,
      [tenant, user.userId, await todayInIndia()],
    );

    const response = await send(token, {
      objectType: 'contact',
      recordId: record,
      subject: 'x',
      body: 'x',
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    const queued = await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_messages where tenant_id = $1`,
      [tenant],
    );
    expect(queued.rows[0]?.n).toBe(0);
  });

  it('stops the whole company at its limit, whoever is sending', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Company Cap Traders' })).tenantId;
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Sales Rep')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Cap',
      email: 'cap@customer.example',
    });
    await superuser.query(
      `insert into email_daily_counts (tenant_id, user_id, day, sent)
       values ($1, gen_random_uuid(), $2::date, 100)`,
      [tenant, await todayInIndia()],
    );
    const response = await send(token, {
      objectType: 'contact',
      recordId: record,
      subject: 'x',
      body: 'x',
    });
    expect(response.status).toBe(429);
  });

  it('allows more once the company is older than two weeks', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Old Traders' })).tenantId;
    await superuser.query(
      `update tenants set created_at = now() - interval '30 days' where id = $1`,
      [tenant],
    );
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Sales Rep')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Old',
      email: 'old@customer.example',
    });
    await superuser.query(
      `insert into email_daily_counts (tenant_id, user_id, day, sent) values ($1, $2, $3::date, 50)`,
      [tenant, user.userId, await todayInIndia()],
    );
    const response = await send(token, {
      objectType: 'contact',
      recordId: record,
      subject: 'x',
      body: 'x',
    });
    expect(response.status).toBe(202);
  });

  it('stops a person who sends more than ten in a minute', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Burst Traders' })).tenantId;
    await superuser.query(
      `update tenants set created_at = now() - interval '30 days' where id = $1`,
      [tenant],
    );
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Sales Rep')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Burst',
      email: 'burst@customer.example',
    });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (
          await send(token, {
            objectType: 'contact',
            recordId: record,
            subject: `n${i}`,
            body: 'x',
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('switching the feature off', () => {
  it('answers 402 to every email route for a company that does not have it', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'No Email Traders' })).tenantId;
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Admin')!);
    const token = await harness.signIn(user.userId, tenant);
    const record = await harness.fixtures.createContact(tenant, {
      ownerId: user.userId,
      lastName: 'Off',
      email: 'off@customer.example',
    });
    await superuser.query(
      `insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
       values (gen_random_uuid(), $1, 'email', false, 'withdrawn for a test')`,
      [tenant],
    );
    expect(
      (await send(token, { objectType: 'contact', recordId: record, subject: 'x', body: 'x' }))
        .status,
    ).toBe(402);
    expect(
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/emails?objectType=contact&recordId=${record}`,
          token,
        })
      ).status,
    ).toBe(402);
    expect(
      (await request(harness, { method: 'GET', url: '/api/v1/email-settings', token })).status,
    ).toBe(402);
  });
});

describe('merging two contacts', () => {
  it('moves the emails of the contact that is merged away onto the one that survives', async () => {
    const master = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Master',
      email: 'master@customer.example',
    });
    const loser = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Loser',
      email: 'loser@customer.example',
    });
    const fromMaster = dataOf<Email>(
      await send(admin.token, { objectType: 'contact', recordId: master, subject: 'M', body: 'x' }),
    );
    const fromLoser = dataOf<Email>(
      await send(admin.token, { objectType: 'contact', recordId: loser, subject: 'L', body: 'x' }),
    );

    const versionOf = async (id: string) =>
      dataOf<{ version: number }>(
        await request(harness, {
          method: 'GET',
          url: `/api/v1/contacts/${id}`,
          token: admin.token,
        }),
      ).version;
    const merged = await request(harness, {
      method: 'POST',
      url: '/api/v1/merges',
      token: admin.token,
      body: {
        objectType: 'contact',
        masterId: master,
        masterVersion: await versionOf(master),
        loserId: loser,
        loserVersion: await versionOf(loser),
        fields: {},
      },
    });
    expect(merged.status).toBeLessThan(300);

    const links = (
      await superuser.query<{ email_message_id: string; record_id: string }>(
        `select email_message_id, record_id from email_message_links
         where email_message_id = any($1::uuid[]) order by email_message_id`,
        [[fromMaster.id, fromLoser.id]],
      )
    ).rows;
    expect(links.map((row) => row.record_id)).toEqual([master, master]);

    const onMaster = (
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/emails?objectType=contact&recordId=${master}`,
          token: admin.token,
        })
      ).body['data'] as Email[]
    ).map((email) => email.id);
    expect(onMaster).toEqual(expect.arrayContaining([fromMaster.id, fromLoser.id]));
  });
});
