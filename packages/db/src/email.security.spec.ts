import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant, withoutTenant } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * What the database allows around email sent from a record (ADR-0073, migration 0032): a company sees
 * its own mail and nobody else's, the application role can write a message once and never change it
 * (only the worker says what the provider did, and only in the columns it needs), a message cannot be
 * stored in a shape the log cannot read, and the platform's routing role has no business here.
 */

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let userA: string;
let messageA: string;
let messageB: string;
let contactA: string;

const as = (tenantId: string) => ({ tenantId, userId: null });
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

async function insertMessage(
  tenantId: string,
  extra: {
    status?: string;
    failureCode?: string | null;
    subject?: string;
    toAddress?: string | null;
    erased?: boolean;
  } = {},
) {
  const id = randomUUID();
  await superuser.query(
    `insert into email_messages
       (id, tenant_id, status, failure_code, source_object_type, source_record_id, from_name,
        from_address, to_address, subject, body_text, message_id, erased_at)
     values ($1, $2, $3, $4, 'contact', $5, 'Acme', 'mail@send.example', $6, $7, 'Hello', $8, $9)`,
    [
      id,
      tenantId,
      extra.status ?? 'queued',
      extra.failureCode ?? null,
      randomUUID(),
      extra.toAddress === undefined ? 'someone@customer.example' : extra.toAddress,
      extra.subject ?? 'Quote',
      `<${id}@send.example>`,
      extra.erased === true ? new Date() : null,
    ],
  );
  return id;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  db = createTestDatabase(urls);
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  tenantA = (await db.fixtures.createTenant({ name: 'Email DB Acme' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Email DB Rival' })).tenantId;
  const roleA = await db.fixtures.createRole(tenantA, 'Rep');
  userA = (await db.fixtures.createUser(tenantA, roleA)).userId;
  contactA = await db.fixtures.createContact(tenantA, {
    ownerId: userA,
    email: 'a@customer.example',
  });
  messageA = await insertMessage(tenantA);
  messageB = await insertMessage(tenantB);
  await superuser.query(
    `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
     values ($1, $2, $3, 'contact', $4), ($5, $6, $7, 'contact', $8)`,
    [randomUUID(), tenantA, messageA, contactA, randomUUID(), tenantB, messageB, randomUUID()],
  );
  await superuser.query(
    `insert into email_sender_config (id, tenant_id, from_name) values ($1, $2, 'Acme'), ($3, $4, 'Rival')`,
    [randomUUID(), tenantA, randomUUID(), tenantB],
  );
  await superuser.query(
    `insert into email_daily_counts (tenant_id, user_id, day, sent)
     values ($1, $2, current_date, 3), ($3, $4, current_date, 9)`,
    [tenantA, userA, tenantB, randomUUID()],
  );
});

afterAll(async () => {
  await superuser.end();
  await db.close();
});

describe('one company never sees another’s mail', () => {
  it.each([
    ['email_messages', 'id'],
    ['email_message_links', 'email_message_id'],
    ['email_sender_config', 'tenant_id'],
    ['email_daily_counts', 'tenant_id'],
  ])('%s is limited to the caller’s own company', async (table, column) => {
    const mine = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql.raw(`select ${column} as k from ${table}`)),
    );
    const theirs = await withTenant(db.app.db, as(tenantB), (tx) =>
      tx.execute(sql.raw(`select ${column} as k from ${table}`)),
    );
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(theirs.rows.length).toBeGreaterThan(0);
    const keys = new Set(mine.rows.map((row) => String(row['k'])));
    for (const row of theirs.rows) expect(keys.has(String(row['k']))).toBe(false);

    const none = await withoutTenant(db.app.db, (tx) =>
      tx.execute(sql.raw(`select ${column} from ${table}`)),
    );
    expect(none.rows).toHaveLength(0);
  });

  it('cannot write a row into another company’s mail log, or point a link at it', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into email_messages
            (id, tenant_id, source_object_type, source_record_id, from_name, from_address,
             to_address, subject, body_text, message_id)
          values (${randomUUID()}, ${tenantB}, 'contact', ${randomUUID()}, 'x', 'a@b.example',
                  'c@d.example', 's', 'b', '<x@y.example>')`),
      ),
    );
    expect(error.code).toBeDefined();
  });

  it('the routing role has no access to any of them', async () => {
    for (const table of [
      'email_messages',
      'email_message_links',
      'email_sender_config',
      'email_daily_counts',
    ]) {
      const error = await captureDbError(() =>
        withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(`select * from ${table}`))),
      );
      expect(error.code, table).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe('a message is written once and never changed by the application', () => {
  it('lets the application role insert and read a message', async () => {
    const id = randomUUID();
    const inserted = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`
        insert into email_messages
          (id, tenant_id, source_object_type, source_record_id, from_name, from_address,
           to_address, subject, body_text, message_id)
        values (${id}, ${tenantA}, 'contact', ${randomUUID()}, 'Acme', 'mail@send.example',
                'c@d.example', 'Hi', 'Body', ${`<${id}@send.example>`})`),
    );
    expect(inserted.rowCount).toBe(1);
  });

  it.each([
    ['change its status', `update email_messages set status = 'sent'`],
    ['change its text', `update email_messages set body_text = 'edited'`],
    ['change who it went to', `update email_messages set to_address = 'x@y.example'`],
    ['delete it', `delete from email_messages`],
  ])('does not let the application role %s', async (_what, statement) => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql.raw(`${statement} where id = '${messageA}'`)),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the worker settle a message, but only in the columns it needs', async () => {
    const id = await insertMessage(tenantA);
    const settled = await withTenant(db.worker.db, as(tenantA), (tx) =>
      tx.execute(
        sql`update email_messages set status = 'sent', provider_message_id = 'p-1', sent_at = now() where id = ${id}`,
      ),
    );
    expect(settled.rowCount).toBe(1);

    for (const column of ['message_id', 'from_address', 'source_record_id', 'direction']) {
      const error = await captureDbError(() =>
        withTenant(db.worker.db, as(tenantA), (tx) =>
          tx.execute(sql.raw(`update email_messages set ${column} = ${column} where id = '${id}'`)),
        ),
      );
      expect(error.code, column).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('lets a merge move a link to another record but never change what kind it is', async () => {
    const moved = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(
        sql`update email_message_links set record_id = record_id where email_message_id = ${messageA}`,
      ),
    );
    expect(moved.rowCount).toBe(1);
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(
          sql`update email_message_links set object_type = 'lead' where email_message_id = ${messageA}`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('a message cannot be stored in a shape the log cannot read', () => {
  it('refuses a failed message with no reason', async () => {
    const error = await captureDbError(() => insertMessage(tenantA, { status: 'failed' }));
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it('refuses a status or a reason outside the lists', async () => {
    expect(
      (await captureDbError(() => insertMessage(tenantA, { status: 'delivering' }))).code,
    ).toBe(CHECK_VIOLATION);
    expect(
      (
        await captureDbError(() =>
          insertMessage(tenantA, { status: 'failed', failureCode: 'boom' }),
        )
      ).code,
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a message with no recipient unless an erasure scrubbed it', async () => {
    expect((await captureDbError(() => insertMessage(tenantA, { toAddress: null }))).code).toBe(
      CHECK_VIOLATION,
    );
    await expect(
      insertMessage(tenantA, { toAddress: null, erased: true, subject: '' }),
    ).resolves.toBeDefined();
  });

  it('refuses an empty or oversized subject', async () => {
    expect((await captureDbError(() => insertMessage(tenantA, { subject: '' }))).code).toBe(
      CHECK_VIOLATION,
    );
    expect(
      (await captureDbError(() => insertMessage(tenantA, { subject: 'x'.repeat(201) }))).code,
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a second message with the same Message-ID in one company, and a second retry of one', async () => {
    const id = await insertMessage(tenantA);
    const duplicate = await captureDbError(() =>
      superuser.query(
        `insert into email_messages
           (id, tenant_id, source_object_type, source_record_id, from_name, from_address,
            to_address, subject, body_text, message_id)
         select $1, tenant_id, source_object_type, source_record_id, from_name, from_address,
                to_address, subject, body_text, message_id
         from email_messages where id = $2`,
        [randomUUID(), id],
      ),
    );
    expect(duplicate.code).toBe(UNIQUE_VIOLATION);

    const failed = await insertMessage(tenantA, { status: 'failed', failureCode: 'rejected' });
    const retry = async () => {
      const retryId = randomUUID();
      await superuser.query(
        `insert into email_messages
           (id, tenant_id, source_object_type, source_record_id, from_name, from_address,
            to_address, subject, body_text, message_id, retry_of)
         values ($1, $2, 'contact', $3, 'Acme', 'mail@send.example', 'c@d.example', 'Hi', 'b', $4, $5)`,
        [retryId, tenantA, randomUUID(), `<${retryId}@send.example>`, failed],
      );
    };
    await retry();
    expect((await captureDbError(retry)).code).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a link to a kind of record an email cannot be about', async () => {
    const error = await captureDbError(() =>
      superuser.query(
        `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
         values ($1, $2, $3, 'activity', $4)`,
        [randomUUID(), tenantA, messageA, randomUUID()],
      ),
    );
    expect(error.code).toBe(CHECK_VIOLATION);
  });
});

describe('the default roles', () => {
  it('give Owner, Admin, Manager and Sales Rep the email grant, and Read-only nothing', async () => {
    const tenantId = (await db.fixtures.createTenant({ name: 'Email DB Roles' })).tenantId;
    await withTenant(db.app.db, as(tenantId), async (tx) => {
      const { provisionTenantDefaults } = await import('./seed/provision.js');
      await provisionTenantDefaults(tx, tenantId, null);
    });
    const rows = await superuser.query<{ name: string; action: string; scope: string }>(
      `select r.name, p.action, p.scope
       from role_permissions p join roles r on r.id = p.role_id and r.tenant_id = p.tenant_id
       where p.tenant_id = $1 and p.object_type = 'email_message'
       order by r.name, p.action`,
      [tenantId],
    );
    const byRole = new Map<string, string[]>();
    for (const row of rows.rows) {
      byRole.set(row.name, [...(byRole.get(row.name) ?? []), `${row.action}:${row.scope}`]);
    }
    for (const role of ['Owner', 'Admin', 'Manager', 'Sales Rep']) {
      expect(byRole.get(role), role).toEqual(['create:all', 'read:all']);
    }
    expect(byRole.has('Read-only')).toBe(false);
  });
});

describe('what an erasure and a purge do to mail', () => {
  it('scrubs the address, subject and body of a person’s emails and keeps the rows', async () => {
    const { erasePersonalColumns } = await import('./data-rights/index.js');
    const person = await db.fixtures.createContact(tenantA, {
      ownerId: userA,
      lastName: 'Erase',
      email: 'erase@customer.example',
    });
    const mine = await insertMessage(tenantA, { subject: 'About Erase' });
    const other = await insertMessage(tenantA, { subject: 'About somebody else' });
    await superuser.query(`update email_messages set contact_id = $2 where id = $1`, [
      mine,
      person,
    ]);
    await superuser.query(
      `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [randomUUID(), tenantA, mine, person],
    );

    await withTenant(db.worker.db, as(tenantA), (tx) =>
      erasePersonalColumns(tx, tenantA, 'contact', person, null),
    );

    const rows = await superuser.query<{
      id: string;
      to_address: string | null;
      subject: string;
      body_text: string;
      erased_at: Date | null;
    }>(
      `select id, to_address, subject, body_text, erased_at from email_messages where id = any($1::uuid[])`,
      [[mine, other]],
    );
    const scrubbed = rows.rows.find((row) => row.id === mine);
    expect(scrubbed).toMatchObject({ to_address: null, subject: '', body_text: '' });
    expect(scrubbed?.erased_at).not.toBeNull();
    const untouched = rows.rows.find((row) => row.id === other);
    expect(untouched).toMatchObject({ subject: 'About somebody else', erased_at: null });
  });

  it('deletes an email when every record it was linked to is purged, and keeps one that is still linked', async () => {
    const { removeReferences } = await import('./recycle-bin/index.js');
    const gone = randomUUID();
    const stays = randomUUID();
    const onlyGone = await insertMessage(tenantA);
    const both = await insertMessage(tenantA);
    await superuser.query(
      `insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4), ($5, $2, $6, 'contact', $4), ($7, $2, $6, 'contact', $8)`,
      [randomUUID(), tenantA, onlyGone, gone, randomUUID(), both, randomUUID(), stays],
    );

    await withTenant(db.worker.db, as(tenantA), (tx) =>
      removeReferences(tx, tenantA, 'contact', [gone]),
    );

    const left = await superuser.query<{ id: string }>(
      `select id from email_messages where id = any($1::uuid[])`,
      [[onlyGone, both]],
    );
    expect(left.rows.map((row) => row.id)).toEqual([both]);
    const links = await superuser.query(
      `select record_id from email_message_links where email_message_id = $1`,
      [both],
    );
    expect(links.rows).toEqual([{ record_id: stays }]);
  });
});
