import { createHmac, randomUUID } from 'node:crypto';
import { resendSigningKey } from '@crm/outbound';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The public door the mail service reports to (ADR-0075), through the real HTTP stack. Signed with the
 * secret Svix publishes for its own examples, so nothing here is a real secret; **nothing here is a test
 * against a real Resend account.** What the worker does with an accepted event is in
 * `apps/worker/src/handlers/email-events.spec.ts`.
 */

const SECRET = 'whsec_plJ3nmyCDGBKInavdOK15jsl';

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let adminB: string;
let messageA: string;
let messageB: string;
let providerA: string;
let providerB: string;

function signedHeaders(
  body: string,
  options: { id?: string; at?: Date; secret?: string } = {},
): Record<string, string> {
  const id = options.id ?? `msg_${randomUUID()}`;
  const timestamp = String(Math.floor((options.at ?? new Date()).getTime() / 1000));
  const key = resendSigningKey(options.secret ?? SECRET)!;
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}

async function post(
  provider: string,
  body: string,
  headers: Record<string, string>,
  app: ApiHarness = harness,
) {
  const response = await app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/api/v1/public/email-events/${provider}`,
      headers,
      payload: body,
    });
  return {
    status: response.statusCode,
    payload: response.payload,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name, String(value)]),
    ),
  };
}

const event = (type: string, emailId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    created_at: '2026-11-22T23:41:12.126Z',
    data: {
      email_id: emailId,
      to: ['bounce@customer.example'],
      subject: 'Secret subject',
      ...extra,
    },
  });

async function insertMessage(tenantId: string, providerId: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, from_name, from_address,
        to_address, subject, body_text, message_id, provider_message_id)
     values ($1, $2, 'sent', 'contact', $3, 'Acme', 'mail@send.example', 'bounce@customer.example',
             'Secret subject', 'Body', $4, $5)`,
    [id, tenantId, randomUUID(), `<${id}@send.example>`, providerId],
  );
  return id;
}

const eventRows = async (tenantId: string) =>
  (
    await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_provider_events where tenant_id = $1`,
      [tenantId],
    )
  ).rows[0]!.n;

const outboxFor = async (messageId: string) =>
  (
    await superuser.query<{ tenant_id: string; payload: Record<string, unknown> }>(
      `select tenant_id, payload from outbox_events
       where record_id = $1 and event_type = 'email.provider_event.v1'`,
      [messageId],
    )
  ).rows;

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { RESEND_WEBHOOK_SECRET: SECRET });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Door Acme' })).tenantId;
  tenantB = (await harness.fixtures.createTenant({ name: 'Door Rival' })).tenantId;
  const rolesB = await harness.provision(tenantB);
  adminB = (await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!)).userId;
  providerA = `resend-a-${randomUUID()}`;
  providerB = `resend-b-${randomUUID()}`;
  messageA = await insertMessage(tenantA, providerA);
  messageB = await insertMessage(tenantB, providerB);
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

describe('accepting a report', () => {
  it('records a signed delivery once, for the company that owns the email, and queues it for the worker', async () => {
    const body = event('email.delivered', providerA);
    const response = await post('resend', body, signedHeaders(body));
    expect(response.status).toBe(204);
    expect(response.payload).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await eventRows(tenantA)).toBe(1);

    const queued = await outboxFor(messageA);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.tenant_id).toBe(tenantA);
    expect(Object.keys(queued[0]!.payload).sort()).toEqual([
      'at',
      'emailId',
      'eventType',
      'reason',
    ]);
    expect(queued[0]!.payload).toMatchObject({
      emailId: messageA,
      eventType: 'delivered',
      reason: null,
    });
  });

  it('does nothing the second time the same event is delivered', async () => {
    const body = event('email.delivered', providerB);
    const headers = signedHeaders(body);
    expect((await post('resend', body, headers)).status).toBe(204);
    expect((await post('resend', body, headers)).status).toBe(204);
    expect(await eventRows(tenantB)).toBe(1);
    expect(await outboxFor(messageB)).toHaveLength(1);
  });

  it('stores and queues ids and a type, never the address, the subject or the provider’s words', async () => {
    const body = event('email.bounced', providerA, {
      bounce: {
        type: 'Permanent',
        subType: 'MessageRejected',
        message: '550 bounce@customer.example no such user',
      },
    });
    await post('resend', body, signedHeaders(body));
    const stored = await superuser.query(
      `select * from email_provider_events where tenant_id = $1`,
      [tenantA],
    );
    const queued = await outboxFor(messageA);
    const everything = JSON.stringify([stored.rows, queued]);
    for (const secret of ['bounce@customer.example', 'Secret subject', 'no such user']) {
      expect(everything).not.toContain(secret);
    }
    expect(queued.some((row) => row.payload['eventType'] === 'bounced')).toBe(true);
  });

  it('is answered 204 and writes nothing for an email it does not know, and for events it does not act on', async () => {
    const before = [await eventRows(tenantA), await eventRows(tenantB)];
    for (const body of [
      event('email.delivered', `not-ours-${randomUUID()}`),
      event('email.sent', providerA),
      event('email.opened', providerA),
      event('email.delivery_delayed', providerA),
      event('email.bounced', providerA, { bounce: { type: 'Temporary', subType: 'MailboxFull' } }),
    ]) {
      expect((await post('resend', body, signedHeaders(body))).status, body.slice(0, 40)).toBe(204);
    }
    expect([await eventRows(tenantA), await eventRows(tenantB)]).toEqual(before);
  });

  it('answers 400 to a body that is not JSON, before anything is checked, and writes nothing', async () => {
    const before = [await eventRows(tenantA), await eventRows(tenantB)];
    const body = 'not json at all';
    expect((await post('resend', body, signedHeaders(body))).status).toBe(400);
    expect([await eventRows(tenantA), await eventRows(tenantB)]).toEqual(before);
  });

  it('finds the company from the email, whatever the request claims to be', async () => {
    const providerId = `resend-claim-${randomUUID()}`;
    const message = await insertMessage(tenantA, providerId);
    const adminToken = await harness.signIn(adminB, tenantB);
    const body = event('email.delivered', providerId);
    const response = await post('resend', body, {
      ...signedHeaders(body),
      'x-tenant-id': tenantB,
      authorization: `Bearer ${adminToken}`,
      cookie: `session=${adminToken}`,
    });
    expect(response.status).toBe(204);
    const queued = await outboxFor(message);
    expect(queued.map((row) => row.tenant_id)).toEqual([tenantA]);
  });

  it('reads a body larger than a contact form’s, up to its own limit, and refuses one beyond it', async () => {
    const providerId = `resend-big-${randomUUID()}`;
    const message = await insertMessage(tenantA, providerId);
    const big = event('email.delivered', providerId, { tags: { note: 'x'.repeat(40_000) } });
    expect((await post('resend', big, signedHeaders(big))).status).toBe(204);
    expect(await outboxFor(message)).toHaveLength(1);

    const huge = event('email.delivered', providerId, { tags: { note: 'x'.repeat(300_000) } });
    expect((await post('resend', huge, signedHeaders(huge))).status).toBe(413);
  });

  it('gives no cross-origin approval', async () => {
    const body = event('email.delivered', providerA);
    const response = await post('resend', body, {
      ...signedHeaders(body),
      origin: 'https://evil.example',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('refusing what is not a verified report', () => {
  const unchanged = async (work: () => Promise<void>) => {
    const before = [await eventRows(tenantA), await eventRows(tenantB)];
    await work();
    expect([await eventRows(tenantA), await eventRows(tenantB)]).toEqual(before);
  };

  it('answers 401 with one fixed body for every failed check, and writes nothing', async () => {
    await unchanged(async () => {
      const providerId = providerA;
      const body = event('email.delivered', providerId);
      const good = signedHeaders(body);
      const attempts: [string, string, Record<string, string>][] = [
        ['no signature headers', body, { 'content-type': 'application/json' }],
        [
          'a wrong signature',
          body,
          { ...good, 'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        ],
        ['a body changed after signing', body.replace('email.delivered', 'email.bounced'), good],
        [
          'another secret',
          body,
          signedHeaders(body, { secret: 'whsec_' + Buffer.from('another').toString('base64') }),
        ],
        ['a stale timestamp', body, signedHeaders(body, { at: new Date(Date.now() - 3_600_000) })],
        ['a future timestamp', body, signedHeaders(body, { at: new Date(Date.now() + 3_600_000) })],
        ['a changed id', body, { ...good, 'svix-id': 'msg_other' }],
      ];
      const answers = new Set<string>();
      for (const [what, payload, headers] of attempts) {
        const response = await post('resend', payload, headers);
        expect(response.status, what).toBe(401);
        answers.add(response.payload.replace(/"requestId":"[^"]*"/, '"requestId":"x"'));
      }
      // The same answer every time: nothing says which part was wrong.
      expect(answers.size).toBe(1);
      expect([...answers][0]).toContain('This request could not be verified');
    });
  });

  it('answers 404 for a provider it does not read, however the request is signed', async () => {
    await unchanged(async () => {
      const body = event('email.delivered', providerA);
      for (const provider of ['sendgrid', 'RESEND', 'x'.repeat(32)]) {
        const response = await post(provider, body, signedHeaders(body));
        expect(response.status, provider).toBe(404);
      }
      expect((await post('x'.repeat(40), body, signedHeaders(body))).status).toBe(422);
    });
  });

  it('answers 404 when no secret is configured, as for any unknown provider', async () => {
    const bare = await startApiHarness(inject('dbUrls'));
    try {
      const body = event('email.delivered', providerA);
      await unchanged(async () => {
        const response = await post('resend', body, signedHeaders(body), bare);
        expect(response.status).toBe(404);
      });
    } finally {
      await bare.close();
    }
  });

  it('is not an authenticated route: a session does not help, and a missing body is not a crash', async () => {
    await unchanged(async () => {
      const token = await harness.signIn(adminB, tenantB);
      const response = await harness.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/public/email-events/resend',
          headers: { authorization: `Bearer ${token}` },
        });
      expect([401, 404, 415, 422]).toContain(response.statusCode);
    });
  });
});
