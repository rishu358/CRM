import { randomUUID } from 'node:crypto';
import { deriveUnsubscribeSecret, issueUnsubscribeToken } from '@crm/core/email-unsubscribe-token';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The unsubscribe link's public door, through the real HTTP stack (ADR-0076). Tokens are signed here with keys
 * made from a repeated letter, so nothing in this file is a real secret. What the worker does with an accepted
 * unsubscribe (blocking the address, withdrawing consent, the timeline) is in
 * `apps/worker/src/handlers/email-events.spec.ts`.
 *
 * The mandatory security suites (CLAUDE.md §10) are the describe blocks marked (a), (c) and (d): there is no
 * "own scope" here (b) because the door has no user, and no hidden field (c) because it reads one value, the
 * name an email was sent under.
 */

const CURRENT_KEY = 'k'.repeat(48);
const PREVIOUS_KEY = 'p'.repeat(48);
const FOREIGN_KEY = 'f'.repeat(48);
const FORM = 'application/x-www-form-urlencoded';
const ONE_CLICK = 'List-Unsubscribe=One-Click';

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let adminB: string;

const signWith = (key: string, emailId: string) =>
  issueUnsubscribeToken(deriveUnsubscribeSecret(key), emailId);

async function insertMessage(
  tenantId: string,
  options: { fromName?: string; address?: string } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, from_name, from_address,
        to_address, subject, body_text, message_id)
     values ($1, $2, 'sent', 'contact', $3, $4, 'mail@send.example', $5, 'Secret subject', 'Body', $6)`,
    [
      id,
      tenantId,
      randomUUID(),
      options.fromName ?? 'Acme Traders',
      options.address ?? 'sam@customer.example',
      `<${id}@send.example>`,
    ],
  );
  return { id, token: signWith(CURRENT_KEY, id) };
}

async function call(
  method: 'GET' | 'POST',
  token: string,
  options: {
    headers?: Record<string, string>;
    payload?: string;
    query?: string;
    app?: ApiHarness;
  } = {},
) {
  const response = await (options.app ?? harness).app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1/public/email-unsubscribe/${token}${options.query ?? ''}`,
      headers: options.headers ?? {},
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  return {
    status: response.statusCode,
    payload: response.payload,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name, String(value)]),
    ),
  };
}

const post = (token: string, headers: Record<string, string> = {}, payload = ONE_CLICK) =>
  call('POST', token, { headers: { 'content-type': FORM, ...headers }, payload });

const eventRows = async (tenantId: string) =>
  (
    await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_provider_events
       where tenant_id = $1 and provider = 'unsubscribe_link'`,
      [tenantId],
    )
  ).rows[0]!.n;

const outboxFor = async (emailId: string) =>
  (
    await superuser.query<{ tenant_id: string; payload: Record<string, unknown> }>(
      `select tenant_id, payload from outbox_events
       where record_id = $1 and event_type = 'email.provider_event.v1'`,
      [emailId],
    )
  ).rows;

/** The name a page answer carries. */
const companyNameOf = (payload: string): string =>
  (JSON.parse(payload) as { data: { companyName: string } }).data.companyName;

/** One answer for every refusal: the body with its request id taken out. */
const sameAnswer = (payload: string) => payload.replace(/"requestId":"[^"]*"/, '"requestId":"x"');

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, {
    AUTH_SECRET: CURRENT_KEY,
    AUTH_SECRET_PREVIOUS: PREVIOUS_KEY,
  });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Unsub Acme' })).tenantId;
  tenantB = (await harness.fixtures.createTenant({ name: 'Unsub Rival' })).tenantId;
  const rolesB = await harness.provision(tenantB);
  adminB = (await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!)).userId;
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

describe('opening the link', () => {
  it('says whose email it is and changes nothing, because a mail scanner opens every link', async () => {
    const mail = await insertMessage(tenantA, { fromName: 'Sharma Traders' });
    const response = await call('GET', mail.token);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ data: { companyName: 'Sharma Traders' } });
    expect(response.headers['cache-control']).toBe('no-store');

    expect(await eventRows(tenantA)).toBe(0);
    expect(await outboxFor(mail.id)).toHaveLength(0);
    // And again, as a scanner and then a person would: still nothing.
    await call('GET', mail.token);
    expect(await outboxFor(mail.id)).toHaveLength(0);
  });

  it('answers the one fixed 404 to every token that does not check out', async () => {
    const mail = await insertMessage(tenantA);
    const signature = mail.token.split('.')[2]!;
    const flipped = `${mail.token.slice(0, -1)}${mail.token.endsWith('A') ? 'B' : 'A'}`;
    const suspended = await insertMessage(tenantB);
    await superuser.query(`update tenants set status = 'suspended' where id = $1`, [tenantB]);
    try {
      const answers = new Set<string>();
      for (const [what, token] of [
        ['nothing like a token', 'hello'],
        ['the wrong version', mail.token.replace('v1.', 'v2.')],
        ['a changed signature', flipped],
        ['a signature on another email', `v1.${randomUUID()}.${signature}`],
        ['a key this installation does not hold', signWith(FOREIGN_KEY, mail.id)],
        ['a good signature for an email that is not there', signWith(CURRENT_KEY, randomUUID())],
        ['an email of a suspended company', suspended.token],
      ] as const) {
        for (const method of ['GET', 'POST'] as const) {
          const response = method === 'GET' ? await call('GET', token) : await post(token);
          expect(response.status, `${method} ${what}`).toBe(404);
          answers.add(sameAnswer(response.payload));
        }
      }
      // The same answer every time: nothing says which part was wrong.
      expect(answers.size).toBe(1);
      expect(await eventRows(tenantA)).toBe(0);
      expect(await eventRows(tenantB)).toBe(0);
    } finally {
      await superuser.query(`update tenants set status = 'active' where id = $1`, [tenantB]);
    }
  });

  it('refuses a query string, so nothing in it can be read', async () => {
    const mail = await insertMessage(tenantA);
    expect((await call('GET', mail.token, { query: `?tenantId=${tenantB}` })).status).toBe(422);
    expect(
      (await call('POST', mail.token, { query: '?tenantId=x', headers: { 'content-type': FORM } }))
        .status,
    ).toBe(422);
  });
});

describe('unsubscribing', () => {
  it('records it once for the company that owns the email, and queues it for the worker', async () => {
    const mail = await insertMessage(tenantA);
    const response = await post(mail.token);
    expect(response.status).toBe(204);
    expect(response.payload).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await eventRows(tenantA)).toBe(1);

    const queued = await outboxFor(mail.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.tenant_id).toBe(tenantA);
    expect(Object.keys(queued[0]!.payload).sort()).toEqual([
      'at',
      'emailId',
      'eventType',
      'reason',
    ]);
    expect(queued[0]!.payload).toMatchObject({
      emailId: mail.id,
      eventType: 'unsubscribed',
      reason: null,
    });
  });

  it('is harmless the second time, and the third: nothing more is recorded or queued', async () => {
    const mail = await insertMessage(tenantA);
    const before = await eventRows(tenantA);
    for (let i = 0; i < 3; i += 1) expect((await post(mail.token)).status).toBe(204);
    expect(await eventRows(tenantA)).toBe(before + 1);
    expect(await outboxFor(mail.id)).toHaveLength(1);
  });

  it('answers the same to a post with no body, which is what a hurried client may send', async () => {
    const mail = await insertMessage(tenantA);
    expect((await call('POST', mail.token)).status).toBe(204);
    expect(await outboxFor(mail.id)).toHaveLength(1);
  });

  it('still accepts a link signed before the secret was rotated, because old emails must keep working', async () => {
    const mail = await insertMessage(tenantA);
    const old = signWith(PREVIOUS_KEY, mail.id);
    expect((await post(old)).status).toBe(204);
    expect(await outboxFor(mail.id)).toHaveLength(1);
  });

  it('stores and queues ids and a type, never the address or the subject', async () => {
    const mail = await insertMessage(tenantA, { address: 'private-person@customer.example' });
    await post(mail.token);
    const stored = await superuser.query(
      `select * from email_provider_events where email_message_id = $1`,
      [mail.id],
    );
    const everything = JSON.stringify([stored.rows, await outboxFor(mail.id)]);
    for (const secret of ['private-person@customer.example', 'Secret subject', 'Acme Traders']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('allows one link twenty uses an hour and then says to wait', async () => {
    const mail = await insertMessage(tenantA);
    let last = 0;
    for (let i = 0; i < 21; i += 1) last = (await post(mail.token)).status;
    expect(last).toBe(429);
    // Still exactly one recording: the limit stopped it, and the repeat rule would have anyway.
    expect(await outboxFor(mail.id)).toHaveLength(1);
  });

  it('refuses a body over the cap before it is read, and gives no cross-origin approval', async () => {
    const mail = await insertMessage(tenantA);
    const huge = await post(mail.token, {}, `${ONE_CLICK}&padding=${'x'.repeat(40_000)}`);
    expect(huge.status).toBe(413);
    expect(await outboxFor(mail.id)).toHaveLength(0);

    const cors = await post(mail.token, { origin: 'https://evil.example' });
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('(a) tenant isolation', () => {
  it('finds the company from the email, whatever the request claims to be', async () => {
    const mail = await insertMessage(tenantA);
    const session = await harness.signIn(adminB, tenantB);
    const response = await post(mail.token, {
      'x-tenant-id': tenantB,
      authorization: `Bearer ${session}`,
      cookie: `session=${session}`,
    });
    expect(response.status).toBe(204);
    expect((await outboxFor(mail.id)).map((row) => row.tenant_id)).toEqual([tenantA]);
  });

  it('never lets company A’s link touch company B, and keeps each company’s records apart', async () => {
    const a = await insertMessage(tenantA, { address: 'same@customer.example' });
    const b = await insertMessage(tenantB, { address: 'same@customer.example' });
    const beforeB = await eventRows(tenantB);
    await post(a.token);
    expect(await eventRows(tenantB)).toBe(beforeB);
    expect(await outboxFor(b.id)).toHaveLength(0);

    await post(b.token);
    expect((await outboxFor(b.id)).map((row) => row.tenant_id)).toEqual([tenantB]);
    expect((await outboxFor(a.id)).map((row) => row.tenant_id)).toEqual([tenantA]);
  });

  it('shows each page only its own company’s name', async () => {
    const a = await insertMessage(tenantA, { fromName: 'Alpha Co' });
    const b = await insertMessage(tenantB, { fromName: 'Beta Co' });
    expect(companyNameOf((await call('GET', a.token)).payload)).toBe('Alpha Co');
    expect(companyNameOf((await call('GET', b.token)).payload)).toBe('Beta Co');
  });
});

describe('(c) what a request may not say', () => {
  it('reads nothing of the body: a company, an address or a reason in it changes nothing', async () => {
    const mail = await insertMessage(tenantA, { address: 'victim@customer.example' });
    const other = await insertMessage(tenantB, { address: 'victim@customer.example' });
    const response = await post(
      mail.token,
      {},
      `${ONE_CLICK}&tenantId=${tenantB}&address=other@customer.example&emailId=${other.id}&reason=complaint`,
    );
    expect(response.status).toBe(204);
    expect((await outboxFor(mail.id)).map((row) => row.tenant_id)).toEqual([tenantA]);
    expect(await outboxFor(other.id)).toHaveLength(0);
    expect((await outboxFor(mail.id))[0]!.payload).toMatchObject({ eventType: 'unsubscribed' });
  });

  it('ignores a JSON body just as it ignores a form one', async () => {
    const mail = await insertMessage(tenantA);
    const response = await call('POST', mail.token, {
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: tenantB, address: 'other@customer.example' }),
    });
    expect(response.status).toBe(204);
    expect((await outboxFor(mail.id)).map((row) => row.tenant_id)).toEqual([tenantA]);
  });
});

describe('(d) no session is needed, and none is used', () => {
  it('works with no credentials at all, and a session does not change the answer', async () => {
    const mail = await insertMessage(tenantA);
    expect((await call('GET', mail.token)).status).toBe(200);
    const session = await harness.signIn(adminB, tenantB);
    const withSession = await call('GET', mail.token, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(withSession.status).toBe(200);
    expect(companyNameOf(withSession.payload)).toBe('Acme Traders');
  });
});
