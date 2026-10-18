import {
  createDbClient,
  PostgresSearchProvider,
  withTenant,
  withoutTenant,
  type DbClient,
  sql,
} from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId, type Uuid } from '@crm/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../relay.js';
import { indexSearchDocument, removeSearchDocument } from './search.js';

/**
 * Index maintenance, driven by the outbox (MVP_SPEC M7, ADR-0028).
 *
 * The property being tested is the one the feature actually promises: **a
 * record created, edited or deleted becomes findable, or stops being
 * findable, without anybody remembering to call an indexer.** So everything
 * here goes through the real relay — claim, tenant-scoped transaction,
 * handler, mark relayed — rather than calling the handler function. The
 * handler on its own could pass while the thing that invokes it was wired to
 * the wrong event, which is the mistake worth catching.
 *
 * Reads of the index go through the provider's own `search`, not a raw SELECT,
 * because "is it in the table" is not the question; "can it be found" is.
 */
const logger = pino({ level: 'silent' });
const provider = new PostgresSearchProvider();

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;

let tenantId: string;
let otherTenant: string;
let ownerId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);

  tenantId = (await fixtures.createTenant({ name: 'Worker Search' })).tenantId;
  otherTenant = (await fixtures.createTenant({ name: 'Worker Search B' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Owner');
  ownerId = (
    await fixtures.createUser(tenantId, roleId, {
      email: `owner-${newId().slice(-12)}@example.com`,
    })
  ).userId;
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

function relay(): OutboxRelay {
  return new OutboxRelay(worker.db, { logger, batchSize: 100 })
    .on('contact.created.v1', indexSearchDocument(provider))
    .on('contact.updated.v1', indexSearchDocument(provider))
    .on('contact.deleted.v1', removeSearchDocument(provider))
    .on('invitation.created.v1', indexSearchDocument(provider));
}

async function enqueue(
  tenant: string,
  eventType: string,
  objectType: string | null,
  recordId: string | null,
): Promise<string> {
  const id = newId();
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload)
      values (${id}, ${tenant}, ${eventType}, ${objectType}, ${recordId}, '{}'::jsonb)
    `),
  );
  return id;
}

/**
 * What an `all`-scope reader in this tenant finds for a term.
 *
 * Deliberately through the provider, as the API does, so a test that says
 * "findable" means findable rather than "a row exists somewhere".
 */
async function findable(tenant: string, term: string): Promise<string[]> {
  const hits = await withTenant(worker.db, { tenantId: tenant, userId: null }, (tx) =>
    provider.search(tx, {
      tenantId: tenant as Uuid,
      term,
      limit: 25,
      scopes: [
        {
          objectType: 'contact',
          constraint: { kind: 'all' },
          fieldKeys: ['first_name', 'last_name', 'email', 'phone'],
        },
      ],
    }),
  );
  return hits.map((hit) => hit.recordId);
}

/** The raw index rows for a record, for assertions about replacement. */
async function indexRows(
  tenant: string,
  recordId: string,
): Promise<{ field_key: string; value: string; owner_id: string | null }[]> {
  const result = await withTenant(worker.db, { tenantId: tenant, userId: null }, (tx) =>
    tx.execute(sql`
      select field_key, value, owner_id from search_documents
      where tenant_id = ${tenant} and record_id = ${recordId}
      order by field_key
    `),
  );
  return result.rows as unknown as { field_key: string; value: string; owner_id: string | null }[];
}

describe('indexing on create and update', () => {
  it('makes a new record findable', async () => {
    const contactId = await fixtures.createContact(tenantId, {
      ownerId,
      firstName: 'Bhavana',
      lastName: 'Rangarajan',
      email: 'bhavana@example.test',
    });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);

    await relay().tick();

    expect(await findable(tenantId, 'Rangarajan')).toContain(contactId);
    expect(await findable(tenantId, 'bhavana@example.test')).toContain(contactId);
  });

  it('replaces the old text rather than adding to it', async () => {
    const contactId = await fixtures.createContact(tenantId, {
      ownerId,
      firstName: 'Mistyped',
      lastName: 'Kurup',
    });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();
    expect(await findable(tenantId, 'Mistyped')).toContain(contactId);

    await superuserPool.query(`update contacts set first_name = 'Corrected' where id = $1`, [
      contactId,
    ]);
    await enqueue(tenantId, 'contact.updated.v1', 'contact', contactId);
    await relay().tick();

    // The old spelling must be gone, not merely outranked: leaving it would
    // keep the record findable by a value it no longer holds.
    expect(await findable(tenantId, 'Corrected')).toContain(contactId);
    expect(await findable(tenantId, 'Mistyped')).not.toContain(contactId);
  });

  it('drops a field that was cleared', async () => {
    const contactId = await fixtures.createContact(tenantId, {
      ownerId,
      lastName: 'Pereira',
      phone: '+919812300001',
    });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();
    expect((await indexRows(tenantId, contactId)).map((row) => row.field_key)).toContain('phone');

    await superuserPool.query(`update contacts set phone = null where id = $1`, [contactId]);
    await enqueue(tenantId, 'contact.updated.v1', 'contact', contactId);
    await relay().tick();

    expect((await indexRows(tenantId, contactId)).map((row) => row.field_key)).not.toContain(
      'phone',
    );
    expect(await findable(tenantId, '9812300001')).not.toContain(contactId);
  });

  it('follows a reassignment, so record scope keeps up', async () => {
    const otherUser = (
      await fixtures.createUser(tenantId, await fixtures.createRole(tenantId, 'Second'), {
        email: `second-${newId().slice(-12)}@example.com`,
      })
    ).userId;

    const contactId = await fixtures.createContact(tenantId, { ownerId, lastName: 'Handover' });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();
    expect((await indexRows(tenantId, contactId))[0]?.owner_id).toBe(ownerId);

    await superuserPool.query(`update contacts set owner_id = $2 where id = $1`, [
      contactId,
      otherUser,
    ]);
    await enqueue(tenantId, 'contact.updated.v1', 'contact', contactId);
    await relay().tick();

    expect((await indexRows(tenantId, contactId))[0]?.owner_id).toBe(otherUser);
  });

  it('writes the same rows when an event is redelivered', async () => {
    // At-least-once delivery is normal, not exceptional (ADR-0006).
    const contactId = await fixtures.createContact(tenantId, { ownerId, lastName: 'Duplicated' });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();
    const first = await indexRows(tenantId, contactId);

    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();

    expect(await indexRows(tenantId, contactId)).toEqual(first);
  });
});

describe('removal', () => {
  it('makes a soft-deleted record unfindable', async () => {
    const contactId = await fixtures.createContact(tenantId, { ownerId, lastName: 'Vanishing' });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();
    expect(await findable(tenantId, 'Vanishing')).toContain(contactId);

    await superuserPool.query(`update contacts set deleted_at = now() where id = $1`, [contactId]);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contactId);
    await relay().tick();

    expect(await findable(tenantId, 'Vanishing')).not.toContain(contactId);
    expect(await indexRows(tenantId, contactId)).toEqual([]);
  });

  it('removes rather than re-indexes when the record has gone since the event', async () => {
    // An update and a delete can be relayed in either order, and a delete
    // that lost the race must not be undone by an update that arrives after
    // it. The index handler reads the record and finds nothing, so it removes.
    const contactId = await fixtures.createContact(tenantId, { ownerId, lastName: 'Racing' });
    await enqueue(tenantId, 'contact.created.v1', 'contact', contactId);
    await relay().tick();

    await superuserPool.query(`update contacts set deleted_at = now() where id = $1`, [contactId]);
    await enqueue(tenantId, 'contact.updated.v1', 'contact', contactId);
    await relay().tick();

    expect(await indexRows(tenantId, contactId)).toEqual([]);
  });

  it('is harmless for a record that was never indexed', async () => {
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', newId());
    await expect(relay().tick()).resolves.toBeGreaterThan(0);
  });
});

describe('what it refuses to index', () => {
  it('ignores an event about something that is not searchable', async () => {
    // `object_type` comes out of a column, so it is validated against the
    // closed set rather than trusted (CLAUDE.md §5.7). An invitation has no
    // document, and the handler must not try to build one.
    await enqueue(tenantId, 'invitation.created.v1', 'invitation', newId());
    await expect(relay().tick()).resolves.toBeGreaterThan(0);
  });

  it('ignores an event with no record', async () => {
    await enqueue(tenantId, 'contact.created.v1', 'contact', null);
    await expect(relay().tick()).resolves.toBeGreaterThan(0);
  });

  it('stays inside the event tenant', async () => {
    // The relay opens a transaction scoped to the event's tenant, so a
    // handler cannot index — or reach — anything outside it. An id from
    // another tenant simply does not resolve, and nothing is written.
    const elsewhere = await fixtures.createContact(otherTenant, { lastName: 'Foreign' });
    await enqueue(tenantId, 'contact.created.v1', 'contact', elsewhere);

    await relay().tick();

    expect(await indexRows(tenantId, elsewhere)).toEqual([]);
    expect(await indexRows(otherTenant, elsewhere)).toEqual([]);
    expect(await findable(tenantId, 'Foreign')).toEqual([]);
  });
});
