import { createDbClient, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../relay.js';
import { linkLeadEmailsOnConversion } from './email-links.js';

/**
 * When a lead is converted its emails also show on the contact and the deal it became (ADR-0074),
 * driven through the real relay: only links are added, a second delivery adds nothing, another
 * workspace's mail is untouched, and an event with nothing to link to does nothing.
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
  tenantId = (await fixtures.createTenant({ name: 'Convert Links' })).tenantId;
  otherTenantId = (await fixtures.createTenant({ name: 'Convert Links Rival' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Rep');
  userId = (await fixtures.createUser(tenantId, roleId)).userId;
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

const relay = () =>
  new OutboxRelay(worker.db, { logger, batchSize: 100 }).on(
    'lead.converted.v1',
    linkLeadEmailsOnConversion(),
  );

async function emailOnLead(tenant: string, leadId: string): Promise<string> {
  const id = newId();
  await superuserPool.query(
    `insert into email_messages
       (id, tenant_id, status, source_object_type, source_record_id, from_name, from_address,
        to_address, subject, body_text, message_id, created_by, updated_by)
     values ($1, $2, 'sent', 'lead', $3, 'Acme', 'mail@send.example', 'lead@prospect.example',
             'Hello', 'Body', $4, $5, $5)`,
    [id, tenant, leadId, `<${id}@send.example>`, userId],
  );
  await superuserPool.query(
    `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
     values ($1, $2, $3, 'lead', $4)`,
    [newId(), tenant, id, leadId],
  );
  return id;
}

async function convert(
  tenant: string,
  leadId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${newId()}, ${tenant}, 'lead.converted.v1', 'lead', ${leadId},
              ${JSON.stringify(payload)}::jsonb, now())
    `),
  );
}

const linksOf = async (messageId: string) =>
  (
    await superuserPool.query<{ object_type: string; record_id: string }>(
      `select object_type, record_id from email_message_links
       where email_message_id = $1 order by object_type, record_id`,
      [messageId],
    )
  ).rows;

describe('converting a lead', () => {
  it('links the lead’s emails to the contact and the deal it became, and keeps the lead link', async () => {
    const leadId = await fixtures.createLead(tenantId, { ownerId: userId, lastName: 'Convert' });
    const contactId = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Convert',
    });
    const dealId = newId();
    const first = await emailOnLead(tenantId, leadId);
    const second = await emailOnLead(tenantId, leadId);
    await convert(tenantId, leadId, { contactId, accountId: null, dealId });
    await relay().tick();

    for (const id of [first, second]) {
      expect(await linksOf(id)).toEqual(
        [
          { object_type: 'contact', record_id: contactId },
          { object_type: 'deal', record_id: dealId },
          { object_type: 'lead', record_id: leadId },
        ].sort((a, b) => a.object_type.localeCompare(b.object_type)),
      );
    }
  });

  it('adds nothing the second time the same event is delivered', async () => {
    const leadId = await fixtures.createLead(tenantId, { ownerId: userId, lastName: 'Twice' });
    const contactId = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Twice',
    });
    const id = await emailOnLead(tenantId, leadId);
    await convert(tenantId, leadId, { contactId, dealId: null });
    await convert(tenantId, leadId, { contactId, dealId: null });
    const instance = relay();
    await instance.tick();
    await instance.tick();
    expect(await linksOf(id)).toHaveLength(2);
  });

  it('touches nothing in another workspace, and nothing when there is no contact or deal', async () => {
    const leadId = await fixtures.createLead(tenantId, { ownerId: userId, lastName: 'Quiet' });
    const mine = await emailOnLead(tenantId, leadId);
    // The same lead id in another workspace has its own email: an event for tenantId never reaches it.
    const theirs = await emailOnLead(otherTenantId, leadId);
    await convert(tenantId, leadId, { contactId: null, dealId: null });
    await relay().tick();
    expect(await linksOf(mine)).toHaveLength(1);

    const contactId = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Quiet',
    });
    await convert(tenantId, leadId, { contactId });
    await relay().tick();
    expect(await linksOf(mine)).toHaveLength(2);
    expect(await linksOf(theirs)).toEqual([{ object_type: 'lead', record_id: leadId }]);
  });

  it('never changes what a message says', async () => {
    const leadId = await fixtures.createLead(tenantId, { ownerId: userId, lastName: 'Words' });
    const contactId = await fixtures.createContact(tenantId, {
      ownerId: userId,
      lastName: 'Words',
    });
    const id = await emailOnLead(tenantId, leadId);
    const before = (
      await superuserPool.query<{
        subject: string;
        body_text: string;
        to_address: string;
        status: string;
      }>(`select subject, body_text, to_address, status from email_messages where id = $1`, [id])
    ).rows[0];
    await convert(tenantId, leadId, { contactId });
    await relay().tick();
    const after = (
      await superuserPool.query<{
        subject: string;
        body_text: string;
        to_address: string;
        status: string;
      }>(`select subject, body_text, to_address, status from email_messages where id = $1`, [id])
    ).rows[0];
    expect(after).toEqual(before);
  });
});
