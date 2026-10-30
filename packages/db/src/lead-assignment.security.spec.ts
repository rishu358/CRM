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
 * What the database allows around lead assignment rules (ADR-0065 10, migration 0028): the rules and
 * their turn-keepers belong to one company each, the platform's routing role has no business here,
 * a rule cannot be written with a shape the engine cannot read, and fifty is the most there can be.
 */

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let ruleA: string;
let ruleB: string;

const as = (tenantId: string) => ({ tenantId, userId: null });

async function insertRule(tenantId: string, name: string, action = `{"type":"default_owner"}`) {
  const id = randomUUID();
  await superuser.query(
    `insert into lead_assignment_rules (id, tenant_id, name, position, action)
     values ($1, $2, $3, 10, $4::jsonb)`,
    [id, tenantId, name, action],
  );
  return id;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  db = createTestDatabase(urls);
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  tenantA = (await db.fixtures.createTenant({ name: 'Rules DB Acme' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rules DB Rival' })).tenantId;
  ruleA = await insertRule(tenantA, 'A rule');
  ruleB = await insertRule(tenantB, 'B rule');
  await superuser.query(
    `insert into lead_assignment_pointers (tenant_id, rule_id) values ($1, $2), ($3, $4)`,
    [tenantA, ruleA, tenantB, ruleB],
  );
});

afterAll(async () => {
  await superuser.end();
  await db.close();
});

describe('who may touch the rules', () => {
  it.each(['lead_assignment_rules', 'lead_assignment_pointers', 'lead_assignment_settings'])(
    'the routing role cannot read %s',
    async (table) => {
      const error = await captureDbError(() =>
        withoutTenant(db.auth.db, (tx) => tx.execute(sql.raw(`select * from ${table}`))),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    },
  );

  it('a company sees its own rules and turn-keepers and nobody else’s', async () => {
    const rules = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`select id from lead_assignment_rules`),
    );
    expect(rules.rows).toEqual([{ id: ruleA }]);
    const pointers = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`select rule_id from lead_assignment_pointers`),
    );
    expect(pointers.rows).toEqual([{ rule_id: ruleA }]);
    const none = await withoutTenant(db.app.db, (tx) =>
      tx.execute(sql`select id from lead_assignment_rules`),
    );
    expect(none.rows).toHaveLength(0);
  });

  it('cannot change, delete or move another company’s rule or pointer', async () => {
    const update = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`update lead_assignment_rules set name = 'Hijacked' where id = ${ruleB}`),
    );
    expect(update.rowCount).toBe(0);
    const remove = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(sql`delete from lead_assignment_rules where id = ${ruleB}`),
    );
    expect(remove.rowCount).toBe(0);
    const pointer = await withTenant(db.app.db, as(tenantA), (tx) =>
      tx.execute(
        sql`update lead_assignment_pointers set last_user_id = gen_random_uuid() where rule_id = ${ruleB}`,
      ),
    );
    expect(pointer.rowCount).toBe(0);
  });

  it('cannot write a rule, or a pointer, into another company', async () => {
    const rule = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(sql`
          insert into lead_assignment_rules (id, tenant_id, name, position, action)
          values (gen_random_uuid(), ${tenantB}, 'Planted', 1, '{"type":"default_owner"}'::jsonb)`),
      ),
    );
    expect(rule.message).toMatch(/row-level security/i);
    const pointer = await captureDbError(() =>
      withTenant(db.app.db, as(tenantA), (tx) =>
        tx.execute(
          sql`insert into lead_assignment_pointers (tenant_id, rule_id) values (${tenantA}, ${ruleB})`,
        ),
      ),
    );
    expect(pointer.message).toMatch(/foreign key|violates/i);
  });

  it('the worker may read, and may not write', async () => {
    const read = await withTenant(db.worker.db, as(tenantA), (tx) =>
      tx.execute(sql`select id from lead_assignment_rules`),
    );
    expect(read.rows).toHaveLength(1);
    const write = await captureDbError(() =>
      withTenant(db.worker.db, as(tenantA), (tx) =>
        tx.execute(sql`update lead_assignment_rules set enabled = false`),
      ),
    );
    expect(write.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('what a rule must look like', () => {
  it.each([
    ['an action of an unknown type', `{"type":"script"}`, 'check_violation'],
    ['an action that is not an object', `[1]`, 'check_violation'],
  ])('refuses %s', async (_label, action) => {
    const error = await captureDbError(() => insertRule(tenantA, `Bad ${randomUUID()}`, action));
    expect(error.code).toBe('23514');
  });

  it('refuses a blank name, a repeated name ignoring case, and no kind of lead', async () => {
    const blank = await captureDbError(() => insertRule(tenantA, '   '));
    expect(blank.code).toBe('23514');
    const same = await captureDbError(() => insertRule(tenantA, 'a RULE'));
    expect(same.code).toBe('23505');
    const none = await captureDbError(() =>
      superuser.query(
        `insert into lead_assignment_rules (id, tenant_id, name, position, applies_to, action)
         values (gen_random_uuid(), $1, 'No kinds', 1, '{}', '{"type":"default_owner"}'::jsonb)`,
        [tenantA],
      ),
    );
    expect(none.code).toBe('23514');
  });

  it('allows fifty rules and not a fifty-first, however they are written', async () => {
    const tenant = (await db.fixtures.createTenant({ name: 'Rules DB Cap' })).tenantId;
    for (let i = 0; i < 50; i += 1) await insertRule(tenant, `Rule ${i}`);
    const over = await captureDbError(() => insertRule(tenant, 'Fifty-first'));
    expect(over.message).toMatch(/at most 50/);
  });

  it('removes a rule’s turn-keeper with the rule', async () => {
    const id = await insertRule(tenantA, 'Short lived');
    await superuser.query(
      `insert into lead_assignment_pointers (tenant_id, rule_id) values ($1, $2)`,
      [tenantA, id],
    );
    await superuser.query(`delete from lead_assignment_rules where id = $1`, [id]);
    const left = await superuser.query(
      `select 1 from lead_assignment_pointers where rule_id = $1`,
      [id],
    );
    expect(left.rows).toHaveLength(0);
  });
});
