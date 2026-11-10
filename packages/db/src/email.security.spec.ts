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

describe('templates and signatures (migration 0033)', () => {
  let templateA: string;
  let templateB: string;

  beforeAll(async () => {
    templateA = randomUUID();
    templateB = randomUUID();
    await superuser.query(
      `insert into email_templates (id, tenant_id, name, subject, body_text)
       values ($1, $2, 'Welcome', 's', 'b'), ($3, $4, 'Welcome', 's', 'b')`,
      [templateA, tenantA, templateB, tenantB],
    );
    await superuser.query(
      `insert into email_signatures (id, tenant_id, user_id, signature_text)
       values ($1, $2, $3, 'A sig'), ($4, $5, $6, 'B sig')`,
      [randomUUID(), tenantA, userA, randomUUID(), tenantB, randomUUID()],
    );
  });

  it.each(['email_templates', 'email_signatures'])(
    '%s is limited to the caller’s own company',
    async (table) => {
      const mine = await withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql.raw(`select tenant_id from ${table}`)),
      );
      expect(mine.rows.length).toBeGreaterThan(0);
      for (const row of mine.rows) expect(row['tenant_id']).toBe(tenantA);
      const none = await withoutTenant(db.app.db, (tx) =>
        tx.execute(sql.raw(`select tenant_id from ${table}`)),
      );
      expect(none.rows).toHaveLength(0);
    },
  );

  it('cannot change or remove another company’s template', async () => {
    const update = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`update email_templates set name = 'Hijacked' where id = ${templateB}`),
    );
    expect(update.rowCount).toBe(0);
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`delete from email_templates where id = ${templateB}`),
      ),
    );
    // No DELETE grant at all: a template is removed by marking it, never by deleting the row.
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the application role write and change a template, and the worker only read it', async () => {
    const id = randomUUID();
    const inserted = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`
        insert into email_templates (id, tenant_id, name, subject, body_text)
        values (${id}, ${tenantA}, 'Mine', 's', 'b')`),
    );
    expect(inserted.rowCount).toBe(1);
    const changed = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`update email_templates set subject = 'new' where id = ${id}`),
    );
    expect(changed.rowCount).toBe(1);
    const error = await captureDbError(() =>
      withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`update email_templates set subject = 'worker' where id = ${id}`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps a template name unique in a company ignoring case, among those in use', async () => {
    const duplicate = (name: string) =>
      superuser.query(
        `insert into email_templates (id, tenant_id, name, subject, body_text)
         values ($1, $2, $3, 's', 'b')`,
        [randomUUID(), tenantA, name],
      );
    expect((await captureDbError(() => duplicate('WELCOME'))).code).toBe(UNIQUE_VIOLATION);
    await superuser.query(`update email_templates set deleted_at = now() where id = $1`, [
      templateA,
    ]);
    await expect(duplicate('welcome')).resolves.toBeDefined();
  });

  it('refuses a template or signature in a shape the screens cannot show', async () => {
    const template = (name: string, subject: string, body: string) =>
      superuser.query(
        `insert into email_templates (id, tenant_id, name, subject, body_text)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenantA, name, subject, body],
      );
    expect((await captureDbError(() => template('', 's', 'b'))).code).toBe(CHECK_VIOLATION);
    expect((await captureDbError(() => template('n1', '', 'b'))).code).toBe(CHECK_VIOLATION);
    expect((await captureDbError(() => template('n2', 's', ''))).code).toBe(CHECK_VIOLATION);
    expect((await captureDbError(() => template('x'.repeat(81), 's', 'b'))).code).toBe(
      CHECK_VIOLATION,
    );
    const signature = (text: string) =>
      superuser.query(
        `insert into email_signatures (id, tenant_id, user_id, signature_text) values ($1, $2, $3, $4)`,
        [randomUUID(), tenantA, randomUUID(), text],
      );
    expect((await captureDbError(() => signature('x'.repeat(501)))).code).toBe(CHECK_VIOLATION);
  });

  it('allows one signature per person', async () => {
    const error = await captureDbError(() =>
      superuser.query(
        `insert into email_signatures (id, tenant_id, user_id, signature_text) values ($1, $2, $3, 'again')`,
        [randomUUID(), tenantA, userA],
      ),
    );
    expect(error.code).toBe(UNIQUE_VIOLATION);
  });

  it('lets the worker add a link to a message, and still not change what the message says', async () => {
    const added = await withTenant(db.worker.db, as(tenantA), (tx) =>
      tx.execute(sql`
        insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
        values (${randomUUID()}, ${tenantA}, ${messageA}, 'deal', ${randomUUID()})`),
    );
    expect(added.rowCount).toBe(1);
    const error = await captureDbError(() =>
      withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`update email_messages set message_id = 'x' where id = ${messageA}`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    // The application role still cannot add a link to another company's message (row-level security).
    const crossed = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into email_message_links (id, tenant_id, email_message_id, object_type, record_id)
          values (${randomUUID()}, ${tenantB}, ${messageB}, 'deal', ${randomUUID()})`),
      ),
    );
    expect(crossed.code).toBeDefined();
  });
});

describe('delivery events, blocked addresses and the pause (migration 0034)', () => {
  const hash = (n: number) => Buffer.alloc(32, n);
  let sentA: string;
  let sentB: string;

  beforeAll(async () => {
    sentA = await insertMessage(tenantA, { status: 'sent' });
    sentB = await insertMessage(tenantB, { status: 'sent' });
    await superuser.query(`update email_messages set provider_message_id = $2 where id = $1`, [
      sentA,
      `prov-a-${sentA}`,
    ]);
    await superuser.query(`update email_messages set provider_message_id = $2 where id = $1`, [
      sentB,
      `prov-b-${sentB}`,
    ]);
  });

  describe('the routing role', () => {
    it('can turn a provider id into a company and an email, and read nothing else', async () => {
      const routed = await withoutTenant(db.auth.db, (tx) =>
        tx.execute(sql`
          select tenant_id, id from email_messages where provider_message_id = ${`prov-a-${sentA}`}`),
      );
      expect(routed.rows).toEqual([{ tenant_id: tenantA, id: sentA }]);

      for (const column of [
        'to_address',
        'subject',
        'body_text',
        'status',
        'from_name',
        'reply_to',
        // The token in the unsubscribe link (migration 0035): the door checks a signature, never reads one.
        'unsubscribe_token',
      ]) {
        const error = await captureDbError(() =>
          withoutTenant(db.auth.db, (tx) =>
            tx.execute(sql.raw(`select ${column} from email_messages limit 1`)),
          ),
        );
        expect(error.code, column).toBe(INSUFFICIENT_PRIVILEGE);
      }
      const star = await captureDbError(() =>
        withoutTenant(db.auth.db, (tx) => tx.execute(sql`select * from email_messages limit 1`)),
      );
      expect(star.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('can neither change nor delete a message, and has no access to the new tables', async () => {
      for (const statement of [
        `update email_messages set status = 'sent'`,
        `delete from email_messages`,
        `insert into email_provider_events (id) values (gen_random_uuid())`,
      ]) {
        const error = await captureDbError(() =>
          withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(statement))),
        );
        expect(error.code, statement).toBe(INSUFFICIENT_PRIVILEGE);
      }
      for (const table of ['email_provider_events', 'email_suppressions', 'email_pauses']) {
        const error = await captureDbError(() =>
          withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(`select * from ${table}`))),
        );
        expect(error.code, table).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  describe('events', () => {
    it('records an event once: the same delivery of the same event again is refused by the table', async () => {
      const insert = (tenant: string, message: string, eventId: string) =>
        withTenant(db.app.db, as(tenant), (tx) =>
          tx.execute(sql`
            insert into email_provider_events
              (id, tenant_id, provider, provider_event_id, email_message_id, event_type)
            values (${randomUUID()}, ${tenant}, 'resend', ${eventId}, ${message}, 'delivered')`),
        );
      const id = `msg_${randomUUID()}`;
      await insert(tenantA, sentA, id);
      expect((await captureDbError(() => insert(tenantA, sentA, id))).code).toBe(UNIQUE_VIOLATION);
      // The same provider id in another company is another row.
      await expect(insert(tenantB, sentB, id)).resolves.toBeDefined();
    });

    it('is the application role’s to write and read, and nobody’s to change', async () => {
      const error = await captureDbError(() =>
        withTenant(db.app.db, as(tenantA), (tx) =>
          tx.execute(sql`update email_provider_events set event_type = 'bounced'`),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      const worker = await captureDbError(() =>
        withTenant(db.worker.db, as(tenantA), (tx) =>
          tx.execute(sql`delete from email_provider_events`),
        ),
      );
      expect(worker.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('refuses a type or a provider name outside the lists, and keeps each company’s events apart', async () => {
      const bad = (type: string, provider: string) =>
        superuser.query(
          `insert into email_provider_events
             (id, tenant_id, provider, provider_event_id, email_message_id, event_type)
           values ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), tenantA, provider, `e-${randomUUID()}`, sentA, type],
        );
      expect((await captureDbError(() => bad('opened', 'resend'))).code).toBe(CHECK_VIOLATION);
      expect((await captureDbError(() => bad('delivered', 'Not A Provider'))).code).toBe(
        CHECK_VIOLATION,
      );
      const mine = await withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`select distinct tenant_id from email_provider_events`),
      );
      expect(mine.rows).toEqual([{ tenant_id: tenantA }]);
    });

    it('holds a bounce reason only from the closed list', async () => {
      const set = (reason: string) =>
        superuser.query(`update email_messages set bounce_reason = $2 where id = $1`, [
          sentA,
          reason,
        ]);
      await expect(set('mailbox_not_found')).resolves.toBeDefined();
      expect(
        (await captureDbError(() => set('Mailbox does not exist: someone@customer.example'))).code,
      ).toBe(CHECK_VIOLATION);
      const worker = await withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`update email_messages set bounce_reason = 'blocked' where id = ${sentA}`),
      );
      expect(worker.rowCount).toBe(1);
    });
  });

  describe('blocked addresses', () => {
    const block = (tenant: string, address: number, reason = 'hard_bounce') =>
      superuser.query(
        `insert into email_suppressions (id, tenant_id, address_hash, reason) values ($1, $2, $3, $4)`,
        [randomUUID(), tenant, hash(address), reason],
      );

    it('keeps the block per company, and holds a hash, never an address', async () => {
      await block(tenantA, 1);
      await block(tenantB, 1);
      const mine = await withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`select tenant_id, octet_length(address_hash) as n from email_suppressions`),
      );
      expect(mine.rows.length).toBeGreaterThan(0);
      for (const row of mine.rows) {
        expect(row['tenant_id']).toBe(tenantA);
        expect(row['n']).toBe(32);
      }
      const columns = await superuser.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'email_suppressions'`,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain('address');
      expect(
        (
          await captureDbError(() =>
            superuser.query(
              `insert into email_suppressions (id, tenant_id, address_hash, reason) values ($1, $2, $3, 'hard_bounce')`,
              [randomUUID(), tenantA, Buffer.alloc(5)],
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });

    it('has one live block per address in a company, and a lifted one makes room', async () => {
      await block(tenantA, 2);
      expect((await captureDbError(() => block(tenantA, 2, 'complaint'))).code).toBe(
        UNIQUE_VIOLATION,
      );
      await withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          update email_suppressions set lifted_at = now(), lifted_by = ${userA}
          where address_hash = ${hash(2)}`),
      );
      await expect(block(tenantA, 2)).resolves.toBeDefined();
    });

    it('cannot be lifted when it is a complaint or an unsubscribe, even by a direct update', async () => {
      for (const [n, reason] of [
        [3, 'complaint'],
        [4, 'unsubscribed'],
      ] as const) {
        await block(tenantA, n, reason);
        const error = await captureDbError(() =>
          withTenant(db.app.db, as(tenantA), (tx) =>
            tx.execute(sql`
              update email_suppressions set lifted_at = now(), lifted_by = ${userA}
              where address_hash = ${hash(n)}`),
          ),
        );
        expect(error.code, reason).toBe(CHECK_VIOLATION);
      }
    });

    it('lets the application role lift a block and nothing else about it, and the worker only add one', async () => {
      const reasonChange = await captureDbError(() =>
        withTenant(db.app.db, as(tenantA), (tx) =>
          tx.execute(sql`update email_suppressions set reason = 'complaint'`),
        ),
      );
      expect(reasonChange.code).toBe(INSUFFICIENT_PRIVILEGE);
      const remove = await captureDbError(() =>
        withTenant(db.app.db, as(tenantA), (tx) => tx.execute(sql`delete from email_suppressions`)),
      );
      expect(remove.code).toBe(INSUFFICIENT_PRIVILEGE);
      const insertAsApp = await captureDbError(() =>
        withTenant(db.app.db, as(tenantA), (tx) =>
          tx.execute(sql`
            insert into email_suppressions (id, tenant_id, address_hash, reason)
            values (${randomUUID()}, ${tenantA}, ${hash(9)}, 'hard_bounce')`),
        ),
      );
      expect(insertAsApp.code).toBe(INSUFFICIENT_PRIVILEGE);
      const added = await withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into email_suppressions (id, tenant_id, address_hash, reason)
          values (${randomUUID()}, ${tenantA}, ${hash(8)}, 'complaint')`),
      );
      expect(added.rowCount).toBe(1);
      const lifting = await captureDbError(() =>
        withTenant(db.worker.db, as(tenantA), (tx) =>
          tx.execute(sql`update email_suppressions set lifted_at = now(), lifted_by = ${userA}`),
        ),
      );
      expect(lifting.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('computes the same key for the same address in the same company, whatever its case', async () => {
      const { emailSuppressionKey } = await import('./email-suppression.js');
      expect(
        emailSuppressionKey(tenantA, 'Someone@Customer.Example ').equals(
          emailSuppressionKey(tenantA, 'someone@customer.example'),
        ),
      ).toBe(true);
      expect(
        emailSuppressionKey(tenantA, 'someone@customer.example').equals(
          emailSuppressionKey(tenantB, 'someone@customer.example'),
        ),
      ).toBe(false);
    });
  });

  describe('the pause', () => {
    it('allows one live pause per company, and a resumed one makes room', async () => {
      const pause = (tenant: string) =>
        superuser.query(
          `insert into email_pauses (id, tenant_id, reason) values ($1, $2, 'bounces')`,
          [randomUUID(), tenant],
        );
      await pause(tenantA);
      await pause(tenantB);
      expect((await captureDbError(() => pause(tenantA))).code).toBe(UNIQUE_VIOLATION);
      await withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`update email_pauses set resumed_at = now(), resumed_by = ${userA}`),
      );
      await expect(pause(tenantA)).resolves.toBeDefined();
    });

    it('is the worker’s to start and the application role’s to end, and each company sees its own', async () => {
      const mine = await withTenant(db.app.db, as(tenantB), (tx) =>
        tx.execute(sql`select distinct tenant_id from email_pauses`),
      );
      expect(mine.rows).toEqual([{ tenant_id: tenantB }]);
      const start = await captureDbError(() =>
        withTenant(db.app.db, as(tenantB), (tx) =>
          tx.execute(sql`
            insert into email_pauses (id, tenant_id, reason) values (${randomUUID()}, ${tenantB}, 'complaints')`),
        ),
      );
      expect(start.code).toBe(INSUFFICIENT_PRIVILEGE);
      const reasonChange = await captureDbError(() =>
        withTenant(db.app.db, as(tenantB), (tx) =>
          tx.execute(sql`update email_pauses set reason = 'complaints'`),
        ),
      );
      expect(reasonChange.code).toBe(INSUFFICIENT_PRIVILEGE);
      const bad = await captureDbError(() =>
        superuser.query(
          `insert into email_pauses (id, tenant_id, reason) values ($1, $2, 'boredom')`,
          [randomUUID(), tenantB],
        ),
      );
      expect(bad.code).toBe(CHECK_VIOLATION);
    });
  });
});

describe('the unsubscribe link (migration 0035)', () => {
  let message: string;
  let rival: string;

  beforeAll(async () => {
    message = await insertMessage(tenantA, { status: 'sent' });
    rival = await insertMessage(tenantB, { status: 'sent' });
    await superuser.query(`update email_messages set unsubscribe_token = $2 where id = $1`, [
      message,
      `v1.${message}.${'A'.repeat(43)}`,
    ]);
  });

  it('is readable by the application role and the worker inside the company, and by nobody across it', async () => {
    for (const role of [db.app, db.worker]) {
      const own = await withTenant(role.db, as(tenantA), (tx) =>
        tx.execute(sql`select unsubscribe_token from email_messages where id = ${message}`),
      );
      expect(own.rows).toEqual([{ unsubscribe_token: `v1.${message}.${'A'.repeat(43)}` }]);
      const across = await withTenant(role.db, as(tenantB), (tx) =>
        tx.execute(sql`select unsubscribe_token from email_messages where id = ${message}`),
      );
      expect(across.rows).toEqual([]);
    }
    const none = await withTenant(db.app.db, as(tenantB), (tx) =>
      tx.execute(sql`select unsubscribe_token from email_messages where id = ${rival}`),
    );
    expect(none.rows).toEqual([{ unsubscribe_token: null }]);
  });

  it('is set once, when the message is written: neither the application role nor the worker can change it', async () => {
    for (const role of [db.app, db.worker]) {
      const error = await captureDbError(() =>
        withTenant(role.db, as(tenantA), (tx) =>
          tx.execute(sql`update email_messages set unsubscribe_token = 'x' where id = ${message}`),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('refuses an empty token and one that is far too long', async () => {
    for (const token of ['', 'a'.repeat(201)]) {
      const error = await captureDbError(() =>
        superuser.query(`update email_messages set unsubscribe_token = $2 where id = $1`, [
          rival,
          token,
        ]),
      );
      expect(error.code, `${token.length} characters`).toBe(CHECK_VIOLATION);
    }
  });

  it('records a person’s own unsubscribe as an event type of its own, and still refuses an unknown type', async () => {
    const insert = (type: string) =>
      superuser.query(
        `insert into email_provider_events
           (id, tenant_id, provider, provider_event_id, email_message_id, event_type)
         values ($1, $2, 'unsubscribe_link', $3, $4, $5)`,
        [randomUUID(), tenantA, `u-${randomUUID()}`, message, type],
      );
    await expect(insert('unsubscribed')).resolves.toBeDefined();
    expect((await captureDbError(() => insert('opened'))).code).toBe(CHECK_VIOLATION);
  });
});
