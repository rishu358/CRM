import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant, withoutTenant } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * What the database itself allows around website lead forms (ADR-0063 3.2, migration 0027).
 *
 * The public door is only as narrow as these grants. `crm_auth` may turn a key into a workspace and a
 * form, by reading five columns of one table, and nothing else; `crm_app` sees only its own
 * workspace's rows; and the two tables that are evidence (consent wording, submissions) cannot be
 * rewritten by the application role.
 */

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let formA: string;
let formB: string;
let keyHashA: Buffer;
let leadA: string;

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

async function makeForm(
  tenantId: string,
  name: string,
  key: string,
): Promise<{ id: string; hash: Buffer }> {
  const id = randomUUID();
  await superuser.query(
    `insert into lead_forms (id, tenant_id, name, fields, consent_text, success_message)
     values ($1, $2, $3, '[]'::jsonb, 'I agree that this company may contact me.', 'Thanks')`,
    [id, tenantId, name],
  );
  const hash = digest(key);
  await superuser.query(
    `insert into lead_form_keys (id, tenant_id, form_id, key_hash, hint) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), tenantId, id, hash, key.slice(-4)],
  );
  return { id, hash };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  db = createTestDatabase(urls);
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await db.fixtures.createTenant({ name: 'Forms DB Acme' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Forms DB Rival' })).tenantId;
  const a = await makeForm(tenantA, 'A form', 'key-a-0001');
  const b = await makeForm(tenantB, 'B form', 'key-b-0002');
  formA = a.id;
  formB = b.id;
  keyHashA = a.hash;
  leadA = await db.fixtures.createLead(tenantA, { lastName: 'Visitor' });
  await superuser.query(
    `insert into lead_form_submissions (id, tenant_id, form_id, lead_id, consent_version, consent_at)
     values ($1, $2, $3, $4, 1, now())`,
    [randomUUID(), tenantA, formA, leadA],
  );
  await superuser.query(
    `insert into lead_form_consent_texts (id, tenant_id, form_id, version, text)
     values ($1, $2, $3, 1, 'I agree that this company may contact me.')`,
    [randomUUID(), tenantA, formA],
  );
});

afterAll(async () => {
  await superuser.end();
  await db.close();
});

describe('crm_auth, the routing role', () => {
  it('turns a key into a workspace and a form, across workspaces, with no tenant context', async () => {
    const rows = await withoutTenant(db.auth.db, (tx) =>
      tx.execute(sql`select tenant_id, form_id from lead_form_keys where key_hash = ${keyHashA}`),
    );
    expect(rows.rows).toEqual([{ tenant_id: tenantA, form_id: formA }]);

    // It sees keys of every workspace: that is the whole job.
    const all = await withoutTenant(db.auth.db, (tx) =>
      tx.execute(sql`select form_id from lead_form_keys where form_id in (${formA}, ${formB})`),
    );
    expect(all.rows).toHaveLength(2);
  });

  it.each([
    ['every column', 'select * from lead_form_keys'],
    ['the hint', 'select hint from lead_form_keys'],
    ['the creator', 'select created_by from lead_form_keys'],
    ['a form', 'select * from lead_forms'],
    ['a form name', 'select name from lead_forms'],
    ['the consent wording', 'select text from lead_form_consent_texts'],
    ['a submission', 'select * from lead_form_submissions'],
    ['the counters', 'select * from lead_form_daily_counts'],
    ['a lead', 'select * from leads'],
    ['a contact', 'select * from contacts'],
    ['a deal', 'select * from deals'],
  ])('cannot read %s', async (_label, statement) => {
    const error = await captureDbError(() =>
      withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(statement))),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each([
    [
      'insert',
      `insert into lead_form_keys (id, tenant_id, form_id, key_hash, hint) values (gen_random_uuid(), '${randomUUID()}', '${randomUUID()}', decode(repeat('ab', 32), 'hex'), 'abcd')`,
    ],
    ['update', `update lead_form_keys set revoked_at = now()`],
    ['delete', `delete from lead_form_keys`],
  ])('cannot %s a key', async (_label, statement) => {
    const error = await captureDbError(() =>
      withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(statement))),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('crm_app, the role every request after the routing uses', () => {
  const as = (tenantId: string) => ({ tenantId, userId: null });

  it('sees its own workspace’s forms and keys and no other', async () => {
    const forms = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`select id from lead_forms`),
    );
    expect(forms.rows).toEqual([{ id: formA }]);
    const keys = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`select form_id from lead_form_keys`),
    );
    expect(keys.rows).toEqual([{ form_id: formA }]);
  });

  it('sees nothing with no workspace set', async () => {
    const rows = await withoutTenant(db.app.db, (tx) => tx.execute(sql`select id from lead_forms`));
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot read, change or delete another workspace’s form or key', async () => {
    const read = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`select id from lead_forms where id = ${formB}`),
    );
    expect(read.rows).toHaveLength(0);
    const update = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`update lead_forms set name = 'Hijacked' where id = ${formB}`),
    );
    expect(update.rowCount).toBe(0);
    const revoke = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`update lead_form_keys set revoked_at = now() where form_id = ${formB}`),
    );
    expect(revoke.rowCount).toBe(0);
  });

  it('cannot write a form, key or submission into another workspace', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into lead_forms (id, tenant_id, name, fields, consent_text, success_message)
          values (gen_random_uuid(), ${tenantB}, 'Planted', '[]'::jsonb,
                  'I agree that this company may contact me.', 'x')`),
      ),
    );
    expect(error.message).toMatch(/row-level security/i);
  });

  it('cannot hard-delete a form or a key, and cannot rewrite or delete evidence', async () => {
    for (const statement of [
      `delete from lead_forms where id = '${formA}'`,
      `delete from lead_form_keys where form_id = '${formA}'`,
      `update lead_form_consent_texts set text = 'Rewritten wording of the consent text.'`,
      `delete from lead_form_consent_texts`,
      `delete from lead_form_submissions`,
    ]) {
      const error = await captureDbError(() =>
        withTenant(db.app.db, as(tenantA), (tx) => tx.execute(sql.raw(statement))),
      );
      expect(error.code, statement).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('cannot give a lead a submission that points at another workspace’s lead', async () => {
    const otherLead = await db.fixtures.createLead(tenantB, { lastName: 'Other' });
    const error = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into lead_form_submissions (id, tenant_id, form_id, lead_id, consent_version, consent_at)
          values (gen_random_uuid(), ${tenantA}, ${formA}, ${otherLead}, 1, now())`),
      ),
    );
    expect(error.message).toMatch(/foreign key|violates/i);
  });

  it('takes from a daily allowance atomically: the cap holds under concurrent takers', async () => {
    const take = () =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into lead_form_daily_counts as c (tenant_id, counter_key, day, count)
          values (${tenantA}, 'form:concurrency', (now() at time zone 'utc')::date, 1)
          on conflict (tenant_id, counter_key, day)
          do update set count = c.count + 1, updated_at = now() where c.count < 7
          returning c.count`),
      );
    const results = await Promise.all(Array.from({ length: 25 }, take));
    expect(results.filter((result) => result.rows.length > 0)).toHaveLength(7);
  });
});

describe('crm_worker', () => {
  const as = (tenantId: string) => ({ tenantId, userId: null });

  it('may delete a submission (erasure) and may not write one', async () => {
    const insert = await captureDbError(() =>
      withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into lead_form_submissions (id, tenant_id, form_id, lead_id, consent_version, consent_at)
          values (gen_random_uuid(), ${tenantA}, ${formA}, ${leadA}, 1, now())`),
      ),
    );
    expect(insert.code).toBe(INSUFFICIENT_PRIVILEGE);

    const removed = await withTenant(db.worker.db, as(tenantA), (tx) =>
      tx.execute(sql`delete from lead_form_submissions where lead_id = ${leadA}`),
    );
    expect(removed.rowCount).toBe(1);
  });
});

describe('the leads a submission points at', () => {
  it('removes the submission with its lead', async () => {
    const lead = await db.fixtures.createLead(tenantA, { lastName: 'Gone' });
    await superuser.query(
      `insert into lead_form_submissions (id, tenant_id, form_id, lead_id, consent_version, consent_at)
       values ($1, $2, $3, $4, 1, now())`,
      [randomUUID(), tenantA, formA, lead],
    );
    await superuser.query(`delete from leads where id = $1`, [lead]);
    const left = await superuser.query(`select 1 from lead_form_submissions where lead_id = $1`, [
      lead,
    ]);
    expect(left.rows).toHaveLength(0);
  });
});

describe('with no user at all (how the public step runs: ADR-0063 section 9)', () => {
  it('writes the lead, the consent record, the audit row, the event and the count, with no author', async () => {
    const leadId = randomUUID();
    const noUser = { tenantId: tenantA, userId: null };

    await withTenant(db.app.db, noUser, async (tx) => {
      await tx.execute(sql`
        insert into leads (id, tenant_id, last_name, source, status, created_by, updated_by)
        values (${leadId}, ${tenantA}, 'No user', 'web_form', 'new', null, null)`);
      await tx.execute(sql`
        insert into lead_form_submissions (id, tenant_id, form_id, lead_id, consent_version, consent_at)
        values (gen_random_uuid(), ${tenantA}, ${formA}, ${leadId}, 1, now())`);
      await tx.execute(sql`
        insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id)
        values (gen_random_uuid(), ${tenantA}, null, 'create', 'lead', ${leadId})`);
      await tx.execute(sql`
        insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload)
        values (gen_random_uuid(), ${tenantA}, 'lead.created.v1', 'lead', ${leadId},
                '{"source":"web_form"}'::jsonb)`);
      await tx.execute(sql`
        insert into lead_form_daily_counts (tenant_id, counter_key, day, count)
        values (${tenantA}, 'form:no-user', (now() at time zone 'utc')::date, 1)
        on conflict (tenant_id, counter_key, day) do update set count = lead_form_daily_counts.count + 1`);
    });

    const stored = await superuser.query(`select created_by, owner_id from leads where id = $1`, [
      leadId,
    ]);
    expect(stored.rows).toEqual([{ created_by: null, owner_id: null }]);
    const audit = await superuser.query(`select actor_id from audit_logs where record_id = $1`, [
      leadId,
    ]);
    expect(audit.rows).toEqual([{ actor_id: null }]);
  });

  it('reads back what it wrote, and nothing of another workspace, with no user set', async () => {
    const rows = await withTenant(db.app.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(
        sql`select id from lead_forms union all select id from leads where tenant_id = ${tenantB}`,
      ),
    );
    expect(rows.rows.map((row) => (row as { id: string }).id)).toEqual([formA]);
  });
});
