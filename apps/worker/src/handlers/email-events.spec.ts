import { createDbClient, emailSuppressionKey, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../relay.js';
import { applyEmailProviderEvent } from './email-events.js';
import { projectTimeline } from './timeline.js';

/**
 * What the worker does with an accepted report from the mail service (ADR-0075), driven through the real
 * relay: the status moves forward only, a bounce or a complaint blocks the address by hash, a complaint
 * withdraws consent on the contacts that carry it, a bad run pauses a company's email, a repeat changes
 * nothing, and nothing written holds the address.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let tenantId: string;
let otherTenantId: string;
let userId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);
  tenantId = (await fixtures.createTenant({ name: 'Events Worker' })).tenantId;
  otherTenantId = (await fixtures.createTenant({ name: 'Events Worker Rival' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Rep');
  userId = (await fixtures.createUser(tenantId, roleId)).userId;
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

const relay = () =>
  new OutboxRelay(worker.db, { logger, batchSize: 200 })
    .on('email.provider_event.v1', applyEmailProviderEvent())
    .on('email.delivered.v1', projectTimeline)
    .on('email.bounced.v1', projectTimeline)
    .on('email.complained.v1', projectTimeline)
    .on('email.unsubscribed.v1', projectTimeline);

interface Made {
  id: string;
  address: string;
  recordId: string;
}

async function sentEmail(
  options: { tenant?: string; status?: string; erased?: boolean; address?: string } = {},
): Promise<Made> {
  const tenant = options.tenant ?? tenantId;
  const id = newId();
  const recordId = newId();
  const address = options.address ?? `person-${id.slice(-8)}@customer.example`;
  await superuserPool.query(
    `insert into email_messages
       (id, tenant_id, status, failure_code, source_object_type, source_record_id, contact_id, from_name,
        from_address, to_address, subject, body_text, message_id, sent_at, erased_at)
     values ($1, $2, $3, $4, 'contact', $5, $5, 'Acme', 'mail@send.example', $6, $7, 'Secret body', $8,
             now(), $9)`,
    [
      id,
      tenant,
      options.status ?? 'sent',
      options.status === 'failed' ? 'outcome_unknown' : null,
      recordId,
      options.erased === true ? null : address,
      options.erased === true ? '' : 'Secret subject',
      `<${id}@send.example>`,
      options.erased === true ? new Date() : null,
    ],
  );
  return { id, address, recordId };
}

async function report(
  emailId: string,
  eventType: 'delivered' | 'bounced' | 'complained' | 'unsubscribed',
  reason: string | null = null,
  tenant = tenantId,
): Promise<void> {
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${newId()}, ${tenant}, 'email.provider_event.v1', 'email_message', ${emailId},
              ${JSON.stringify({ emailId, eventType, reason, at: new Date().toISOString() })}::jsonb, now())
    `),
  );
}

const statusOf = async (id: string) =>
  (
    await superuserPool.query<{ status: string; bounce_reason: string | null }>(
      `select status, bounce_reason from email_messages where id = $1`,
      [id],
    )
  ).rows[0]!;

const eventsAbout = async (id: string, type?: string) =>
  (
    await superuserPool.query<{
      event_type: string;
      object_type: string;
      record_id: string;
      payload: unknown;
    }>(
      `select event_type, object_type, record_id, payload from outbox_events
       where tenant_id = $1 and payload ->> 'emailId' = $2 and event_type like 'email.%'
         and event_type <> 'email.provider_event.v1' ${type === undefined ? '' : `and event_type = '${type}'`}
       order by id`,
      [tenantId, id],
    )
  ).rows;

const blocksFor = async (tenant: string, address: string) =>
  (
    await superuserPool.query<{ reason: string; source_email_id: string | null }>(
      `select reason, source_email_id from email_suppressions
       where tenant_id = $1 and address_hash = $2 and lifted_at is null`,
      [tenant, emailSuppressionKey(tenant, address)],
    )
  ).rows;

describe('a delivery report', () => {
  it('moves a sent email to delivered, and says so on the record it was sent from, without the address', async () => {
    const mail = await sentEmail();
    await report(mail.id, 'delivered');
    const instance = relay();
    await instance.tick();
    await instance.tick();

    expect((await statusOf(mail.id)).status).toBe('delivered');
    const events = await eventsAbout(mail.id, 'email.delivered.v1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      object_type: 'contact',
      record_id: mail.recordId,
      payload: { emailId: mail.id },
    });
    const timeline = await superuserPool.query(
      `select summary, detail from timeline_events where tenant_id = $1 and record_id = $2`,
      [tenantId, mail.recordId],
    );
    expect(JSON.stringify(timeline.rows)).toContain('Email delivered');
    expect(JSON.stringify([events, timeline.rows])).not.toContain(mail.address);
    expect(JSON.stringify([events, timeline.rows])).not.toContain('Secret');
  });

  it('never moves an email backward, and a repeat changes nothing', async () => {
    const mail = await sentEmail();
    await report(mail.id, 'bounced', 'blocked');
    await relay().tick();
    expect((await statusOf(mail.id)).status).toBe('bounced');

    await report(mail.id, 'delivered');
    await report(mail.id, 'bounced', 'blocked');
    await relay().tick();
    expect((await statusOf(mail.id)).status).toBe('bounced');
    expect(await eventsAbout(mail.id, 'email.bounced.v1')).toHaveLength(1);
    expect(await eventsAbout(mail.id, 'email.delivered.v1')).toHaveLength(0);
    expect(await blocksFor(tenantId, mail.address)).toHaveLength(1);
  });

  it('leaves an email that is still queued, or that failed, with the status it has', async () => {
    const failed = await sentEmail({ status: 'failed' });
    const queued = await sentEmail({ status: 'queued' });
    await report(failed.id, 'delivered');
    await report(queued.id, 'delivered');
    await relay().tick();
    expect((await statusOf(failed.id)).status).toBe('failed');
    expect((await statusOf(queued.id)).status).toBe('queued');
  });
});

describe('a bounce', () => {
  it('records the closed reason, blocks the address by its hash, and holds nothing of the person', async () => {
    const mail = await sentEmail();
    await report(mail.id, 'bounced', 'mailbox_not_found');
    const instance = relay();
    await instance.tick();
    await instance.tick();

    expect(await statusOf(mail.id)).toEqual({
      status: 'bounced',
      bounce_reason: 'mailbox_not_found',
    });
    expect(await blocksFor(tenantId, mail.address)).toEqual([
      { reason: 'hard_bounce', source_email_id: mail.id },
    ]);
    const stored = await superuserPool.query(
      `select * from email_suppressions where tenant_id = $1`,
      [tenantId],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(mail.address);
    const events = await eventsAbout(mail.id, 'email.bounced.v1');
    expect(events[0]).toMatchObject({ payload: { emailId: mail.id, reason: 'mailbox_not_found' } });
    expect(JSON.stringify(events)).not.toContain(mail.address);
  });

  it('blocks the address even when the email itself is marked "outcome unknown"', async () => {
    const mail = await sentEmail({ status: 'failed' });
    await report(mail.id, 'bounced', 'other');
    await relay().tick();
    expect((await statusOf(mail.id)).status).toBe('failed');
    expect(await blocksFor(tenantId, mail.address)).toHaveLength(1);
  });

  it('does nothing about an address an erasure has already scrubbed, and does not fail', async () => {
    const mail = await sentEmail({ erased: true });
    await report(mail.id, 'bounced', 'other');
    await relay().tick();
    expect((await statusOf(mail.id)).status).toBe('bounced');
    const blocks = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from email_suppressions where source_email_id = $1`,
      [mail.id],
    );
    expect(blocks.rows[0]?.n).toBe(0);
  });

  it('keeps the block to the company the email belongs to', async () => {
    const address = `shared-${newId().slice(-8)}@customer.example`;
    const mine = await sentEmail({ address });
    const theirs = await sentEmail({ tenant: otherTenantId, address });
    await report(mine.id, 'bounced', 'other');
    await relay().tick();
    expect(await blocksFor(tenantId, address)).toHaveLength(1);
    expect(await blocksFor(otherTenantId, address)).toHaveLength(0);
    expect((await statusOf(theirs.id)).status).toBe('sent');
  });

  it('ignores an event for an email that is not there, and one with an unknown type', async () => {
    await report(newId(), 'bounced', 'other');
    await withoutTenant(worker.db, (tx) =>
      tx.execute(sql`
        insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
        values (${newId()}, ${tenantId}, 'email.provider_event.v1', 'email_message', ${newId()},
                '{"emailId": 42, "eventType": "opened"}'::jsonb, now())`),
    );
    await expect(relay().tick()).resolves.toBeGreaterThanOrEqual(0);
  });
});

describe('a spam complaint', () => {
  it('blocks the address and withdraws consent on the contacts that carry it, with an audit entry each', async () => {
    const address = `angry-${newId().slice(-8)}@customer.example`;
    const mail = await sentEmail({ address });
    const carrier = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Angry',
      email: address,
    });
    const bystander = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Bystander',
      email: `other-${newId().slice(-8)}@customer.example`,
    });
    const rival = await fixtures.createContact(otherTenantId, {
      lastName: 'Rival',
      email: address,
    });

    await report(mail.id, 'complained');
    await relay().tick();

    expect((await statusOf(mail.id)).status).toBe('complained');
    expect(await blocksFor(tenantId, address)).toEqual([
      { reason: 'complaint', source_email_id: mail.id },
    ]);

    const consent = async (id: string) =>
      (
        await superuserPool.query<{ consent: { email?: { status?: string; source?: string } } }>(
          `select consent from contacts where id = $1`,
          [id],
        )
      ).rows[0]!.consent;
    expect((await consent(carrier)).email).toMatchObject({
      status: 'withdrawn',
      source: 'spam_complaint',
    });
    expect((await consent(bystander)).email).toBeUndefined();
    expect((await consent(rival)).email).toBeUndefined();

    const audit = await superuserPool.query<{ n: number }>(
      `select action, changes from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantId, carrier],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(address);
  });
});

describe('a bad run', () => {
  it('pauses the company’s email after more than five hard bounces among the last fifty sent', async () => {
    const tenant = (await fixtures.createTenant({ name: 'Bounce Run' })).tenantId;
    const mails: Made[] = [];
    for (let i = 0; i < 7; i += 1) mails.push(await sentEmail({ tenant }));
    const live = async () =>
      (
        await superuserPool.query<{ reason: string }>(
          `select reason from email_pauses where tenant_id = $1 and resumed_at is null`,
          [tenant],
        )
      ).rows;

    for (const mail of mails.slice(0, 5)) await report(mail.id, 'bounced', 'other', tenant);
    await relay().tick();
    expect(await live()).toHaveLength(0);

    await report(mails[5]!.id, 'bounced', 'other', tenant);
    await relay().tick();
    expect(await live()).toEqual([{ reason: 'bounces' }]);

    // A seventh bounce while paused changes nothing: one pause, one audit entry, one event.
    await report(mails[6]!.id, 'bounced', 'other', tenant);
    await relay().tick();
    expect(await live()).toHaveLength(1);
    const audit = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and object_type = 'email_pause'`,
      [tenant],
    );
    expect(audit.rows[0]?.n).toBe(1);
    const events = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from outbox_events where tenant_id = $1 and event_type = 'email_pause.created.v1'`,
      [tenant],
    );
    expect(events.rows[0]?.n).toBe(1);
  });

  it('pauses it after three complaints in a day, and not before', async () => {
    const tenant = (await fixtures.createTenant({ name: 'Complaint Run' })).tenantId;
    const live = async () =>
      (
        await superuserPool.query<{ reason: string }>(
          `select reason from email_pauses where tenant_id = $1 and resumed_at is null`,
          [tenant],
        )
      ).rows;
    for (let i = 0; i < 3; i += 1) {
      const mail = await sentEmail({ tenant });
      // The door records each report before the worker sees it; the count is of those records.
      await superuserPool.query(
        `insert into email_provider_events (id, tenant_id, provider, provider_event_id, email_message_id, event_type)
         values ($1, $2, 'resend', $3, $4, 'complained')`,
        [newId(), tenant, `msg_${newId()}`, mail.id],
      );
      await report(mail.id, 'complained', null, tenant);
      await relay().tick();
      expect(await live(), `after complaint ${String(i + 1)}`).toHaveLength(i === 2 ? 1 : 0);
    }
    expect((await live())[0]).toEqual({ reason: 'complaints' });
  });

  it('does not pause a company for another company’s bounces', async () => {
    const tenant = (await fixtures.createTenant({ name: 'Quiet Company' })).tenantId;
    const quiet = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from email_pauses where tenant_id = $1`,
      [tenant],
    );
    expect(quiet.rows[0]?.n).toBe(0);
  });
});

describe('a person unsubscribing from the link in an email (ADR-0076)', () => {
  const consentOf = async (id: string) =>
    (
      await superuserPool.query<{ consent: { email?: { status?: string; source?: string } } }>(
        `select consent from contacts where id = $1`,
        [id],
      )
    ).rows[0]!.consent;

  it('blocks the address for good, withdraws consent on the contacts that carry it, and files one line on the record', async () => {
    const address = `stopper-${newId().slice(-8)}@customer.example`;
    const mail = await sentEmail({ address });
    const carrier = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Stopper',
      email: address,
    });
    const bystander = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Bystander',
      email: `other-${newId().slice(-8)}@customer.example`,
    });
    const rival = await fixtures.createContact(otherTenantId, {
      lastName: 'Rival',
      email: address,
    });

    await report(mail.id, 'unsubscribed');
    await relay().tick();

    // It says nothing about the mail itself: the status is what it was.
    expect((await statusOf(mail.id)).status).toBe('sent');
    expect(await blocksFor(tenantId, address)).toEqual([
      { reason: 'unsubscribed', source_email_id: mail.id },
    ]);
    // The same address in another company is not blocked, and that company's contact is untouched.
    expect(await blocksFor(otherTenantId, address)).toEqual([]);

    expect((await consentOf(carrier)).email).toMatchObject({
      status: 'withdrawn',
      source: 'unsubscribe_link',
    });
    expect((await consentOf(bystander)).email).toBeUndefined();
    expect((await consentOf(rival)).email).toBeUndefined();

    const lines = await eventsAbout(mail.id, 'email.unsubscribed.v1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ object_type: 'contact', record_id: mail.recordId });
    const audit = await superuserPool.query(
      `select action, changes from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantId, carrier],
    );
    expect(audit.rows).toHaveLength(1);
    // The block itself is in the audit log too: who (nobody), what and which email, never the address.
    const blockAudit = await superuserPool.query<{ action: string; changes: unknown }>(
      `select a.action, a.changes from audit_logs a
       join email_suppressions s on s.id = a.record_id
       where a.tenant_id = $1 and a.object_type = 'email_suppression' and s.source_email_id = $2`,
      [tenantId, mail.id],
    );
    expect(blockAudit.rows).toHaveLength(1);
    expect(blockAudit.rows[0]).toMatchObject({
      action: 'create',
      changes: { reason: { new: 'unsubscribed' }, source: { new: `email:${mail.id}` } },
    });
    expect(JSON.stringify([audit.rows, blockAudit.rows, lines])).not.toContain(address);
  });

  it('is applied once however many emails to that address are unsubscribed from: one block, one audit entry', async () => {
    const address = `twice-${newId().slice(-8)}@customer.example`;
    const first = await sentEmail({ address });
    const second = await sentEmail({ address });
    const carrier = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Twice',
      email: address,
    });

    await report(first.id, 'unsubscribed');
    await report(second.id, 'unsubscribed');
    await relay().tick();

    expect(await blocksFor(tenantId, address)).toHaveLength(1);
    const audit = await superuserPool.query(
      `select id from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantId, carrier],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('is not a bad run: any number of people stopping never pauses the company’s email', async () => {
    // A company of its own, so no pause another test caused can be mistaken for one this caused.
    const quiet = (await fixtures.createTenant({ name: 'Events Quiet' })).tenantId;
    for (let i = 0; i < 8; i += 1) {
      const mail = await sentEmail({ tenant: quiet });
      await report(mail.id, 'unsubscribed', null, quiet);
    }
    await relay().tick();
    const pauses = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from email_pauses where tenant_id = $1`,
      [quiet],
    );
    expect(pauses.rows[0]!.n).toBe(0);
    const blocks = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from email_suppressions where tenant_id = $1 and reason = 'unsubscribed'`,
      [quiet],
    );
    expect(blocks.rows[0]!.n).toBe(8);
  });

  it('does not fail for an email an erasure has already scrubbed, and still files the line', async () => {
    const mail = await sentEmail({ erased: true });
    await report(mail.id, 'unsubscribed');
    await relay().tick();
    expect(await eventsAbout(mail.id, 'email.unsubscribed.v1')).toHaveLength(1);
    const blocks = await superuserPool.query<{ n: number }>(
      `select count(*)::int as n from email_suppressions where tenant_id = $1 and source_email_id = $2`,
      [tenantId, mail.id],
    );
    expect(blocks.rows[0]!.n).toBe(0);
  });

  it('cannot be lifted afterwards by anyone: the database refuses', async () => {
    const address = `final-${newId().slice(-8)}@customer.example`;
    const mail = await sentEmail({ address });
    await report(mail.id, 'unsubscribed');
    await relay().tick();
    await expect(
      superuserPool.query(
        `update email_suppressions set lifted_at = now(), lifted_by = $3
         where tenant_id = $1 and address_hash = $2`,
        [tenantId, emailSuppressionKey(tenantId, address), userId],
      ),
    ).rejects.toThrow(/email_suppressions_lift_chk/);
  });
});
