import { newId } from '@crm/core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant, withoutTenant, type Tx } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * What migration 0022 promises (ADR-0047).
 *
 * `tenant_entitlements` decides which features a workspace has beyond its plan, so the one thing it
 * must never allow is a workspace writing its own. These are properties of the database, proved as
 * the real roles against a real Postgres:
 *
 *   - the application role and the worker read their own workspace's rows and **cannot write any**;
 *   - neither can read another workspace's;
 *   - the operator's role (`crm_auth`) can write, and a row must say why.
 */

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let userA: string;

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

beforeAll(async () => {
  superuser = new pg.Pool({ connectionString: inject('dbUrls').superuser, max: 2 });
  db = createTestDatabase(inject('dbUrls'));
  tenantA = (await db.fixtures.createTenant({ name: 'Entitled Traders' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rival Entitled Traders' })).tenantId;
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

function asWorker<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db.worker.db, { tenantId, userId: null }, work);
}

function asOperator<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return withoutTenant(db.auth.db, work);
}

async function seed(tenantId: string, feature: string, enabled: boolean): Promise<string> {
  const id = newId();
  await superuser.query(
    `insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
     values ($1, $2, $3, $4, 'seeded for a test')`,
    [id, tenantId, feature, enabled],
  );
  return id;
}

async function row(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await superuser.query(`select * from tenant_entitlements where id = $1`, [id]);
  return result.rows[0] as Record<string, unknown> | undefined;
}

describe('what a workspace can see of the overrides', () => {
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    mine = await seed(tenantA, 'exports', false);
    theirs = await seed(tenantB, 'imports', false);
  });

  it('is its own rows, as the application role', async () => {
    const result = await asApp(tenantA, (tx) =>
      tx.execute(sql`select id from tenant_entitlements`),
    );
    const ids = result.rows.map((r) => (r as { id: string }).id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('is its own rows, as the worker', async () => {
    const result = await asWorker(tenantA, (tx) =>
      tx.execute(sql`select id from tenant_entitlements`),
    );
    const ids = result.rows.map((r) => (r as { id: string }).id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('is nothing at all when no workspace is named', async () => {
    const result = await withoutTenant(db.app.db, (tx) =>
      tx.execute(sql`select id from tenant_entitlements`),
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe('what a workspace cannot do to the overrides', () => {
  it('cannot grant itself a feature, as the application role', async () => {
    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(
          sql`insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
              values (${newId()}::uuid, ${tenantA}::uuid, 'imports', true, 'I said so')`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot lift a withdrawal, change or remove its own override', async () => {
    const id = await seed(tenantA, 'own_override', false);
    for (const statement of [
      sql`update tenant_entitlements set enabled = true where id = ${id}::uuid`,
      sql`delete from tenant_entitlements where id = ${id}::uuid`,
    ]) {
      const error = await captureDbError(() => asApp(tenantA, (tx) => tx.execute(statement)));
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect((await row(id))?.['enabled']).toBe(false);
  });

  it('cannot write as the worker either', async () => {
    const error = await captureDbError(() =>
      asWorker(tenantA, (tx) =>
        tx.execute(
          sql`insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
              values (${newId()}::uuid, ${tenantA}::uuid, 'imports', true, 'worker')`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot write another workspace a feature', async () => {
    const error = await captureDbError(() =>
      asApp(tenantA, (tx) =>
        tx.execute(
          sql`insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
              values (${newId()}::uuid, ${tenantB}::uuid, 'imports', false, 'sabotage')`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('what the operator role can do', () => {
  it('writes, changes and removes an override for any workspace', async () => {
    const id = newId();
    await asOperator((tx) =>
      tx.execute(
        sql`insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
            values (${id}::uuid, ${tenantB}::uuid, 'pilot_feature', true, 'pilot until March')`,
      ),
    );
    expect((await row(id))?.['enabled']).toBe(true);

    await asOperator((tx) =>
      tx.execute(sql`update tenant_entitlements set enabled = false where id = ${id}::uuid`),
    );
    expect((await row(id))?.['enabled']).toBe(false);

    await asOperator((tx) =>
      tx.execute(sql`delete from tenant_entitlements where id = ${id}::uuid`),
    );
    expect(await row(id)).toBeUndefined();
  });

  it('must give a reason, a well-formed feature name, and one decision per feature', async () => {
    const insert = (feature: string, reason: string) =>
      captureDbError(() =>
        asOperator((tx) =>
          tx.execute(
            sql`insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
                values (${newId()}::uuid, ${tenantA}::uuid, ${feature}, true, ${reason})`,
          ),
        ),
      );

    expect((await insert('imports', '   ')).code).toBe(CHECK_VIOLATION);
    expect((await insert('Not A Feature', 'why')).code).toBe(CHECK_VIOLATION);

    await seed(tenantA, 'once_only', true);
    expect((await insert('once_only', 'again')).code).toBe(UNIQUE_VIOLATION);
  });

  it('goes with the workspace when it is deleted', async () => {
    const gone = (await db.fixtures.createTenant({ name: 'Short Lived Traders' })).tenantId;
    const id = await seed(gone, 'doomed', false);
    await superuser.query(`delete from tenants where id = $1`, [gone]);
    expect(await row(id)).toBeUndefined();
  });
});
