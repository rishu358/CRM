import { newId } from '@crm/core';
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
 * What migration 0017 promises (MVP_SPEC M2, ADR-0037).
 *
 * Two things are proved here, both of which are properties of the database and
 * not of any code that uses it, which is why they sit beside the RLS suite and
 * run against a real Postgres as the real application roles:
 *
 *   - the application role may edit a company's profile and **nothing else about
 *     its tenant** — not the plan it is on, not its status, slug or region;
 *   - the sample-data registry is tenant-isolated and, to the application, an
 *     append-only fact: it can add and remove rows, never rewrite one.
 *
 * Neither may be skipped or weakened to make something else pass.
 */

let db: TestDatabase;
let tenantA: string;
let tenantB: string;
let userA: string;

/** `23514` — check_violation, `23505` — unique_violation. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

beforeAll(async () => {
  db = createTestDatabase(inject('dbUrls'));
  tenantA = (await db.fixtures.createTenant({ name: 'Setup Traders' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rival Setup Traders' })).tenantId;
  const roleA = await db.fixtures.createRole(tenantA, 'Admin', { isSystem: true });
  userA = (await db.fixtures.createUser(tenantA, roleA)).userId;
});

afterAll(async () => {
  await db.close();
});

async function readTenant(tenantId: string): Promise<Record<string, unknown>> {
  const result = await withTenant(db.app.db, { tenantId, userId: userA }, (tx) =>
    tx.execute(
      sql`select name, plan, status, slug, region, default_currency, timezone, industry,
                 setup_completed_at, settings
          from tenants where id = ${tenantId}::uuid`,
    ),
  );
  return result.rows[0] as Record<string, unknown>;
}

describe('the application role may edit a company profile, and nothing else about its tenant', () => {
  it('can change the columns a company-profile screen edits', async () => {
    await withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
      tx.execute(
        sql`update tenants
            set name = 'Setup Traders Pvt Ltd', default_currency = 'USD',
                timezone = 'Asia/Dubai', industry = 'retail', setup_completed_at = now(),
                updated_at = now()
            where id = ${tenantA}::uuid`,
      ),
    );

    const row = await readTenant(tenantA);
    expect(row['name']).toBe('Setup Traders Pvt Ltd');
    expect(row['default_currency']).toBe('USD');
    expect(row['timezone']).toBe('Asia/Dubai');
    expect(row['industry']).toBe('retail');
    expect(row['setup_completed_at']).not.toBeNull();
  });

  it.each([
    ['plan', `plan = 'enterprise'`],
    ['status', `status = 'suspended'`],
    ['slug', `slug = 'taken-over'`],
    ['region', `region = 'eu-west-1'`],
    ['settings', `settings = '{"flag": true}'::jsonb`],
    ['created_at', `created_at = now() - interval '1 year'`],
  ])('cannot change %s: a request path with a bug must not be able to', async (_column, set) => {
    const before = await readTenant(tenantA);

    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
        tx.execute(sql.raw(`update tenants set ${set} where id = '${tenantA}'`)),
      ),
    );

    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await readTenant(tenantA)).toEqual(before);
  });

  it('cannot change another company, whatever the column', async () => {
    const before = await readTenant(tenantB);

    const result = await withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
      tx.execute(sql`update tenants set name = 'Hijacked' where id = ${tenantB}::uuid`),
    );

    // RLS hides the row, so the statement is not refused — it simply matches nothing.
    expect(result.rowCount).toBe(0);
    expect(await readTenant(tenantB)).toEqual(before);
  });

  it('cannot be used to rename a company with no tenant context at all', async () => {
    const result = await withoutTenant(db.app.db, (tx) =>
      tx.execute(sql`update tenants set name = 'Nobody' where id = ${tenantA}::uuid`),
    );
    expect(result.rowCount).toBe(0);
  });

  it('is not something the worker role can do either', async () => {
    const error = await captureDbError(() =>
      withTenant(db.worker.db, { tenantId: tenantA, userId: null }, (tx) =>
        tx.execute(sql`update tenants set name = 'Worker rename' where id = ${tenantA}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('rejects an industry that is empty or absurdly long', async () => {
    for (const industry of ['   ', 'x'.repeat(81)]) {
      const error = await captureDbError(() =>
        withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
          tx.execute(sql`update tenants set industry = ${industry} where id = ${tenantA}::uuid`),
        ),
      );
      expect(error.code, JSON.stringify(industry)).toBe(CHECK_VIOLATION);
    }
  });
});

describe('the sample-data registry', () => {
  async function register(tenantId: string, objectType = 'contact'): Promise<string> {
    const recordId = newId();
    await withTenant(db.app.db, { tenantId, userId: userA }, (tx) =>
      tx.execute(
        sql`insert into sample_records (id, tenant_id, object_type, record_id)
            values (${newId()}, ${tenantId}::uuid, ${objectType}, ${recordId}::uuid)`,
      ),
    );
    return recordId;
  }

  async function visibleTo(tenantId: string): Promise<string[]> {
    const result = await withTenant(db.app.db, { tenantId, userId: userA }, (tx) =>
      tx.execute(sql`select record_id::text as record_id from sample_records`),
    );
    return (result.rows as { record_id: string }[]).map((row) => row.record_id);
  }

  it("cannot be read across tenants: A sees A's rows and never B's", async () => {
    const mine = await register(tenantA);
    const theirs = await register(tenantB);

    const seenByA = await visibleTo(tenantA);
    expect(seenByA).toContain(mine);
    expect(seenByA).not.toContain(theirs);

    const seenByB = await visibleTo(tenantB);
    expect(seenByB).toContain(theirs);
    expect(seenByB).not.toContain(mine);
  });

  it('is empty to a request with no tenant context', async () => {
    await register(tenantA);
    const result = await withoutTenant(db.app.db, (tx) =>
      tx.execute(sql`select count(*)::int as n from sample_records`),
    );
    expect((result.rows[0] as { n: number }).n).toBe(0);
  });

  it("cannot be used to register a record under another tenant's id", async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
        tx.execute(
          sql`insert into sample_records (id, tenant_id, object_type, record_id)
              values (${newId()}, ${tenantB}::uuid, 'contact', ${newId()}::uuid)`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot be deleted across tenants', async () => {
    const theirs = await register(tenantB);

    const result = await withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
      tx.execute(sql`delete from sample_records where record_id = ${theirs}::uuid`),
    );

    expect(result.rowCount).toBe(0);
    expect(await visibleTo(tenantB)).toContain(theirs);
  });

  it('is a fact the application can add and remove but never rewrite', async () => {
    const recordId = await register(tenantA);

    const rewrite = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
        tx.execute(
          sql`update sample_records set object_type = 'deal' where record_id = ${recordId}::uuid`,
        ),
      ),
    );
    expect(rewrite.code).toBe(INSUFFICIENT_PRIVILEGE);

    await withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
      tx.execute(sql`delete from sample_records where record_id = ${recordId}::uuid`),
    );
    expect(await visibleTo(tenantA)).not.toContain(recordId);
  });

  it("lets the worker's purge sweep delete a registration, and nothing more", async () => {
    const recordId = await register(tenantA);

    await withTenant(db.worker.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(sql`delete from sample_records where record_id = ${recordId}::uuid`),
    );
    expect(await visibleTo(tenantA)).not.toContain(recordId);

    const insert = await captureDbError(() =>
      withTenant(db.worker.db, { tenantId: tenantA, userId: null }, (tx) =>
        tx.execute(
          sql`insert into sample_records (id, tenant_id, object_type, record_id)
              values (${newId()}, ${tenantA}::uuid, 'contact', ${newId()}::uuid)`,
        ),
      ),
    );
    expect(insert.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('registers each record once', async () => {
    const recordId = await register(tenantA, 'deal');
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
        tx.execute(
          sql`insert into sample_records (id, tenant_id, object_type, record_id)
              values (${newId()}, ${tenantA}::uuid, 'deal', ${recordId}::uuid)`,
        ),
      ),
    );
    expect(error.code).toBe(UNIQUE_VIOLATION);
  });

  it('only names object types that can be sample data', async () => {
    for (const objectType of ['role', 'tenant_settings', 'audit_log', '']) {
      const error = await captureDbError(() =>
        withTenant(db.app.db, { tenantId: tenantA, userId: userA }, (tx) =>
          tx.execute(
            sql`insert into sample_records (id, tenant_id, object_type, record_id)
                values (${newId()}, ${tenantA}::uuid, ${objectType}, ${newId()}::uuid)`,
          ),
        ),
      );
      expect(error.code, JSON.stringify(objectType)).toBe(CHECK_VIOLATION);
    }
  });
});
