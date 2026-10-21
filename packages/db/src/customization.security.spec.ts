import { newId } from '@crm/core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant, type Tx } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * What migration 0019 promises (MVP_SPEC M9, ADR-0039).
 *
 * `field_definitions` describes the shape of every record in a company. These are
 * properties of the database, so they are proved against a real Postgres as the
 * real application roles and sit beside the RLS suite:
 *
 *   - the application can add and edit a definition, but **never delete one** and
 *     never change its `key`, `type` or `object_type` — records hold values under
 *     them — and the worker can read and nothing more;
 *   - a picklist option, once offered, cannot be removed;
 *   - a company has at most sixty custom fields per object, even under
 *     concurrency.
 *
 * None may be skipped or weakened to make something else pass.
 */

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let userA: string;

const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  superuser = new pg.Pool({ connectionString: inject('dbUrls').superuser, max: 2 });
  db = createTestDatabase(inject('dbUrls'));
  tenantA = (await db.fixtures.createTenant({ name: 'Custom Traders' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rival Custom Traders' })).tenantId;
  const roleA = await db.fixtures.createRole(tenantA, 'Admin', { isSystem: true });
  userA = (await db.fixtures.createUser(tenantA, roleA)).userId;
});

afterAll(async () => {
  await db.close();
  await superuser.end();
});

function asApp<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db.app.db, { tenantId, userId: userA }, work);
}

async function row(id: string): Promise<Record<string, unknown>> {
  const result = await superuser.query(`select * from field_definitions where id = $1`, [id]);
  return result.rows[0] as Record<string, unknown>;
}

describe('what the application role may do to a definition', () => {
  let fieldId: string;

  beforeAll(async () => {
    fieldId = await db.fixtures.createFieldDefinition(tenantA, {
      objectType: 'contact',
      key: 'gstin',
      type: 'text',
      label: 'GSTIN',
    });
  });

  it('can add a definition and edit what an administrator edits', async () => {
    await asApp(tenantA, (tx) =>
      tx.execute(
        sql`update field_definitions
            set label = 'GST number', required = true, section = 'Tax', help_text = 'Fifteen characters',
                position = 5, is_active = false, version = version + 1,
                validation = '{"maxLength": 15}'::jsonb, updated_at = now(), updated_by = ${userA}::uuid
            where id = ${fieldId}::uuid`,
      ),
    );
    const after = await row(fieldId);
    expect(after['label']).toBe('GST number');
    expect(after['section']).toBe('Tax');
    expect(after['is_active']).toBe(false);
    expect(after['version']).toBe(2);
  });

  it.each([
    ['key', `key = 'renamed'`],
    ['type', `type = 'number'`],
    ['object_type', `object_type = 'lead'`],
    ['is_system', `is_system = true`],
    ['is_unique', `is_unique = true`],
    ['tenant_id', `tenant_id = '${newId()}'`],
    ['default_value', `default_value = '"x"'::jsonb`],
  ])('cannot change %s, which records hold values under', async (_column, set) => {
    const before = await row(fieldId);
    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(sql.raw(`update field_definitions set ${set} where id = '${fieldId}'`)),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await row(fieldId)).toEqual(before);
  });

  it('cannot delete a definition: deactivating keeps the data, and that is the only way out', async () => {
    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(sql`delete from field_definitions where id = ${fieldId}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await row(fieldId)).toBeDefined();
  });

  it('cannot edit or add to another company, because RLS hides it', async () => {
    const theirs = await db.fixtures.createFieldDefinition(tenantB, {
      objectType: 'contact',
      key: 'secret',
      type: 'text',
    });
    const result = await asApp(tenantA, (tx) =>
      tx.execute(sql`update field_definitions set label = 'Hijacked' where id = ${theirs}::uuid`),
    );
    expect(result.rowCount).toBe(0);
    expect((await row(theirs))['label']).toBe('secret');

    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(
          sql`insert into field_definitions (id, tenant_id, object_type, key, label, type)
              values (${newId()}::uuid, ${tenantB}::uuid, 'contact', 'planted', 'Planted', 'text')`,
        ),
      ),
    );
    expect(error.code).toBeDefined();
  });
});

describe('what the worker may do', () => {
  it('can read definitions, to build the search index and exports', async () => {
    const result = await withTenant(db.worker.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(sql`select count(*)::int as n from field_definitions`),
    );
    expect((result.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it.each([
    [
      'insert',
      () =>
        sql`insert into field_definitions (id, tenant_id, object_type, key, label, type)
            values (${newId()}::uuid, ${tenantA}::uuid, 'contact', 'by_worker', 'By worker', 'text')`,
    ],
    ['update', () => sql`update field_definitions set label = 'x'`],
    ['delete', () => sql`delete from field_definitions`],
  ])('cannot %s', async (_verb, statement) => {
    const error = await captureDbError(() =>
      withTenant(db.worker.db, { tenantId: tenantA, userId: null }, (tx) =>
        tx.execute(statement()),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('a picklist option, once offered, stays', () => {
  let fieldId: string;

  beforeAll(async () => {
    fieldId = await db.fixtures.createFieldDefinition(tenantA, {
      objectType: 'lead',
      key: 'temperature',
      type: 'picklist',
      options: [
        { value: 'hot', label: 'Hot' },
        { value: 'warm', label: 'Warm' },
      ],
    });
  });

  const setOptions = (options: unknown) =>
    asApp(tenantA, (tx) =>
      tx.execute(
        sql`update field_definitions set options = ${JSON.stringify(options)}::jsonb where id = ${fieldId}::uuid`,
      ),
    );

  it('refuses a list that no longer contains a value it had', async () => {
    const error = await captureDbError(() => setOptions([{ value: 'hot', label: 'Hot' }]));
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.message).toMatch(/cannot be removed/);
    expect((await row(fieldId))['options']).toHaveLength(2);
  });

  it('refuses to clear the list', async () => {
    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(sql`update field_definitions set options = null where id = ${fieldId}::uuid`),
      ),
    );
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it('allows a relabel, a reorder, a deactivation and a new option', async () => {
    await setOptions([
      { value: 'warm', label: 'Lukewarm', isActive: false },
      { value: 'hot', label: 'Hot' },
      { value: 'cold', label: 'Cold' },
    ]);
    expect(((await row(fieldId))['options'] as unknown[]).length).toBe(3);
  });

  it('refuses more than a hundred options', async () => {
    const options = [
      { value: 'warm', label: 'Warm' },
      { value: 'hot', label: 'Hot' },
      { value: 'cold', label: 'Cold' },
      ...Array.from({ length: 98 }, (_, n) => ({ value: `o${n}`, label: `Option ${n}` })),
    ];
    const error = await captureDbError(() => setOptions(options));
    expect(error.code).toBe(CHECK_VIOLATION);
  });
});

describe('at most sixty custom fields per object', () => {
  async function addCustom(tenantId: string, objectType: string, key: string) {
    await asApp(tenantId, (tx) =>
      tx.execute(
        sql`insert into field_definitions (id, tenant_id, object_type, key, label, type)
            values (${newId()}::uuid, ${tenantId}::uuid, ${objectType}, ${key}, ${key}, 'text')`,
      ),
    );
  }

  it('refuses the sixty-first, and counts per object and per company', async () => {
    const t = (await db.fixtures.createTenant({ name: 'Cap Traders' })).tenantId;
    for (let n = 0; n < 60; n += 1) await addCustom(t, 'deal', `f${n}`);

    const error = await captureDbError(() => addCustom(t, 'deal', 'one_too_many'));
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.message).toMatch(/at most 60/);

    // Another object of the same company, and the same object of another company,
    // each have their own sixty.
    await addCustom(t, 'lead', 'fine');
    await addCustom(tenantA, 'deal', 'fine_too');
  }, 60_000);

  it('does not count a system field against the sixty', async () => {
    const t = (await db.fixtures.createTenant({ name: 'System Traders' })).tenantId;
    for (let n = 0; n < 60; n += 1) {
      await db.fixtures.createFieldDefinition(t, {
        objectType: 'account',
        key: `s${n}`,
        type: 'text',
        isSystem: true,
      });
    }
    await addCustom(t, 'account', 'custom_one');
  }, 60_000);

  it('still lets a system field in when the custom cap has been reached', async () => {
    const t = (await db.fixtures.createTenant({ name: 'Full Traders' })).tenantId;
    for (let n = 0; n < 60; n += 1) await addCustom(t, 'lead', `f${n}`);
    await db.fixtures.createFieldDefinition(t, {
      objectType: 'lead',
      key: 'shipped_later',
      type: 'text',
      isSystem: true,
    });
  }, 60_000);

  it('holds under concurrency: an administrator who counts 59 while another is mid-insert waits, and then finds 60', async () => {
    const t = (await db.fixtures.createTenant({ name: 'Race Traders' })).tenantId;
    for (let n = 0; n < 59; n += 1) await addCustom(t, 'contact', `f${n}`);

    // The first transaction takes the sixtieth slot and stays open. The second starts
    // while it is open: without the lock it counts 59 (the first is uncommitted) and
    // both commit, which is sixty-one.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const first = asApp(t, async (tx) => {
      await tx.execute(
        sql`insert into field_definitions (id, tenant_id, object_type, key, label, type)
            values (${newId()}::uuid, ${t}::uuid, 'contact', 'racer_a', 'A', 'text')`,
      );
      await gate;
    });
    await sleep(300);
    const second = captureDbError(() => addCustom(t, 'contact', 'racer_b'));
    await sleep(600);
    release();
    await first;

    const error = await second;
    expect(error.code).toBe(CHECK_VIOLATION);
    const count = await superuser.query(
      `select count(*)::int as n from field_definitions where tenant_id = $1 and object_type = 'contact'`,
      [t],
    );
    expect((count.rows[0] as { n: number }).n).toBe(60);
  }, 60_000);
});

describe('the other limits the table enforces', () => {
  const insert = (set: string) =>
    captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(
          sql.raw(
            `insert into field_definitions (id, tenant_id, object_type, key, label, type ${set.split('|')[0]})
             values ('${newId()}', '${tenantA}', 'contact', 'k_${Math.random().toString(36).slice(2, 8)}', 'Label', 'text' ${set.split('|')[1]})`,
          ),
        ),
      ),
    );

  it.each([
    ['an empty section', `, section|, ''`],
    ['a section over 60 characters', `, section|, '${'s'.repeat(61)}'`],
    ['a help text over 280 characters', `, help_text|, '${'h'.repeat(281)}'`],
  ])('refuses %s', async (_name, set) => {
    expect((await insert(set)).code).toBe(CHECK_VIOLATION);
  });
});
