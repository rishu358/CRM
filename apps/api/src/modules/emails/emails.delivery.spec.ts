import { randomUUID } from 'node:crypto';
import { emailSuppressionKey } from '@crm/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Blocked addresses, the pause and what a bounce looks like on the screen's data (ADR-0075), through the
 * real HTTP stack. The worker writes blocks and pauses from what the mail service reports (its spec is in
 * `apps/worker`); here they are written as the worker would, so what the API does with them can be seen.
 * The security suites for the same routes are in `emails.delivery.security.spec.ts`.
 */

interface Person {
  token: string;
  userId: string;
}
interface Suppression {
  id: string;
  address: string | null;
  reason: string;
  liftable: boolean;
}
interface Email {
  id: string;
  status: string;
  bounceReason: string | null;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantId: string;
let admin: Person;
let rep: Person;
let blockedContact: string;
let okContact: string;
let blockedLead: string;

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) => request(harness, { method, url: `/api/v1${url}`, token, body });

const sendTo = (token: string, recordId: string, objectType: 'contact' | 'lead' = 'contact') =>
  call(token, 'POST', '/emails', { objectType, recordId, subject: 'Hello', body: 'Hi there' });

async function block(
  tenant: string,
  address: string,
  reason: 'hard_bounce' | 'complaint' | 'unsubscribed',
  sourceEmail: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_suppressions (id, tenant_id, address_hash, reason, source_email_id)
     values ($1, $2, $3, $4, $5)`,
    [id, tenant, emailSuppressionKey(tenant, address), reason, sourceEmail],
  );
  return id;
}

async function sentEmailTo(tenant: string, address: string, recordId: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, contact_id, from_name,
        from_address, to_address, subject, body_text, message_id)
     values ($1, $2, 'sent', 'contact', $3, $3, 'Acme', 'mail@send.example', $4, 'Earlier', 'Body', $5)`,
    [id, tenant, recordId, address, `<${id}@send.example>`],
  );
  await superuser.query(
    `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
     values ($1, $2, $3, 'contact', $4)`,
    [randomUUID(), tenant, id, recordId],
  );
  return id;
}

const queued = async (tenant: string) =>
  (
    await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_messages where tenant_id = $1 and status = 'queued'`,
      [tenant],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { EMAIL_OUTREACH_FROM: 'mail@send.example' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantId = (await harness.fixtures.createTenant({ name: 'Delivery Traders' })).tenantId;
  const roles = await harness.provision(tenantId);
  const make = async (roleName: string) => {
    const user = await harness.fixtures.createUser(tenantId, roles.get(roleName)!);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  admin = await make('Admin');
  rep = await make('Sales Rep');

  blockedContact = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    lastName: 'Blocked',
    email: 'blocked@customer.example',
  });
  okContact = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    lastName: 'Fine',
    email: 'fine@customer.example',
  });
  blockedLead = await harness.fixtures.createLead(tenantId, {
    ownerId: rep.userId,
    lastName: 'SameAddress',
    email: 'blocked@customer.example',
  });
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes' where tenant_id = $1`,
    [tenantId],
  );
});

describe('a blocked address', () => {
  it('is refused with the reason, before anything is spent or queued', async () => {
    await block(tenantId, 'blocked@customer.example', 'hard_bounce');
    const before = await queued(tenantId);
    const response = await sendTo(rep.token, blockedContact);
    expect(response.status).toBe(422);
    expect(response.body['error']).toMatchObject({
      code: 'ADDRESS_SUPPRESSED',
      details: [expect.objectContaining({ meta: { reason: 'hard_bounce' } })],
    });
    expect(await queued(tenantId)).toBe(before);
    const used = await superuser.query<{ n: number }>(
      `select coalesce(sum(sent), 0)::int as n from email_daily_counts where tenant_id = $1`,
      [tenantId],
    );
    expect(used.rows[0]!.n).toBe(0);
  });

  it('is blocked by address, not by record: a lead with the same address is refused too', async () => {
    const response = await sendTo(rep.token, blockedLead, 'lead');
    expect(response.status).toBe(422);
    expect(response.body['error']).toMatchObject({ code: 'ADDRESS_SUPPRESSED' });
  });

  it('does not touch another address', async () => {
    expect((await sendTo(rep.token, okContact)).status).toBe(202);
  });

  it('is said in the dialog’s context before anything is typed', async () => {
    const blocked = dataOf<{
      suppressed: { reason: string; since: string } | null;
      paused: boolean;
    }>(
      await call(rep.token, 'GET', `/emails/context?objectType=contact&recordId=${blockedContact}`),
    );
    expect(blocked.suppressed).toMatchObject({ reason: 'hard_bounce' });
    expect(blocked.paused).toBe(false);
    const fine = dataOf<{ suppressed: unknown }>(
      await call(rep.token, 'GET', `/emails/context?objectType=contact&recordId=${okContact}`),
    );
    expect(fine.suppressed).toBeNull();
  });
});

describe('the list, and lifting a block', () => {
  it('shows the address from the email that caused the block, and says which can be lifted', async () => {
    const source = await sentEmailTo(tenantId, 'listed@customer.example', okContact);
    await block(tenantId, 'listed@customer.example', 'hard_bounce', source);
    await block(tenantId, 'complained@customer.example', 'complaint');
    const listed = dataOf<Suppression[]>(await call(admin.token, 'GET', '/email-suppressions'));
    const byReason = (reason: string) => listed.find((entry) => entry.reason === reason);
    expect(listed.find((entry) => entry.address === 'listed@customer.example')).toMatchObject({
      reason: 'hard_bounce',
      liftable: true,
    });
    // No email holds this address any more, so the list cannot say it, and does not guess.
    expect(byReason('complaint')).toMatchObject({ address: null, liftable: false });
  });

  it('lifts a bounce after the address is corrected, and then the address can be written to', async () => {
    const listed = dataOf<Suppression[]>(await call(admin.token, 'GET', '/email-suppressions'));
    const target = listed.find((entry) => entry.address === 'listed@customer.example')!;

    const lifted = await call(admin.token, 'POST', `/email-suppressions/${target.id}/lift`);
    expect(lifted.status).toBe(204);
    const after = dataOf<Suppression[]>(await call(admin.token, 'GET', '/email-suppressions'));
    expect(after.map((entry) => entry.id)).not.toContain(target.id);

    // A second lift of the same block is a plain 404.
    expect((await call(admin.token, 'POST', `/email-suppressions/${target.id}/lift`)).status).toBe(
      404,
    );

    const entries = await harness.fixtures.auditEntries(tenantId, 'email_suppression');
    expect(entries.find((entry) => entry.recordId === target.id)?.action).toBe('update');
    expect(JSON.stringify(entries)).not.toContain('listed@customer.example');
  });

  it('lets the original address be written to once its block is lifted', async () => {
    const listed = dataOf<Suppression[]>(await call(admin.token, 'GET', '/email-suppressions'));
    // The block on blocked@customer.example has no source email, so it is found by its reason.
    const live = listed.find((entry) => entry.liftable && entry.address === null)!;
    expect((await sendTo(rep.token, blockedContact)).status).toBe(422);
    expect((await call(admin.token, 'POST', `/email-suppressions/${live.id}/lift`)).status).toBe(
      204,
    );
    expect((await sendTo(rep.token, blockedContact)).status).toBe(202);
  });

  it('will not lift a complaint or an unsubscribe: 409, and the address stays blocked', async () => {
    const complaint = dataOf<Suppression[]>(
      await call(admin.token, 'GET', '/email-suppressions'),
    ).find((entry) => entry.reason === 'complaint')!;
    const response = await call(admin.token, 'POST', `/email-suppressions/${complaint.id}/lift`);
    expect(response.status).toBe(409);
    const still = dataOf<Suppression[]>(await call(admin.token, 'GET', '/email-suppressions'));
    expect(still.map((entry) => entry.id)).toContain(complaint.id);

    const unsubscribed = await block(tenantId, 'stopped@customer.example', 'unsubscribed');
    expect(
      (await call(admin.token, 'POST', `/email-suppressions/${unsubscribed}/lift`)).status,
    ).toBe(409);
  });
});

describe('the pause', () => {
  it('stops every send in the company, says so in the context and the settings, and ends when an administrator resumes it', async () => {
    await superuser.query(
      `insert into email_pauses (id, tenant_id, reason) values ($1, $2, 'bounces')`,
      [randomUUID(), tenantId],
    );

    const refused = await sendTo(rep.token, okContact);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toMatchObject({ code: 'EMAIL_PAUSED' });

    const context = dataOf<{ paused: boolean }>(
      await call(rep.token, 'GET', `/emails/context?objectType=contact&recordId=${okContact}`),
    );
    expect(context.paused).toBe(true);
    const settings = dataOf<{ paused: { reason: string; since: string } | null }>(
      await call(admin.token, 'GET', '/email-settings'),
    );
    expect(settings.paused).toMatchObject({ reason: 'bounces' });

    expect((await call(admin.token, 'POST', '/email-pause/resume')).status).toBe(204);
    expect((await call(admin.token, 'POST', '/email-pause/resume')).status).toBe(409);
    expect((await sendTo(rep.token, okContact)).status).toBe(202);
    expect(
      dataOf<{ paused: unknown }>(await call(admin.token, 'GET', '/email-settings')).paused,
    ).toBeNull();

    const entries = await harness.fixtures.auditEntries(tenantId, 'email_pause');
    expect(entries.map((entry) => entry.action)).toContain('update');
  });
});

describe('what a bounce looks like', () => {
  it('carries the status and the closed reason, and nothing from the mail service', async () => {
    const id = await sentEmailTo(tenantId, 'bounced@customer.example', okContact);
    await superuser.query(
      `update email_messages set status = 'bounced', bounce_reason = 'mailbox_not_found' where id = $1`,
      [id],
    );
    const email = dataOf<Email>(await call(admin.token, 'GET', `/emails/${id}`));
    expect(email).toMatchObject({ status: 'bounced', bounceReason: 'mailbox_not_found' });
  });

  it('has no reason for an email that did not bounce', async () => {
    const id = await sentEmailTo(tenantId, 'fine2@customer.example', okContact);
    expect(dataOf<Email>(await call(admin.token, 'GET', `/emails/${id}`)).bounceReason).toBeNull();
  });
});
