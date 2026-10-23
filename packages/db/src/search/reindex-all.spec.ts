import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { createDbClient, type DbClient } from '../client.js';
import { Fixtures } from '../testing/fixtures.js';
import { reindexAll } from './reindex-all.js';

/**
 * `pnpm db:reindex` (ADR-0028 §3, ADR-0041): rebuild a company's search index from its records.
 *
 * Run against the real roles, because the point of the two-client shape is that neither role could do
 * the whole job alone.
 */
let worker: DbClient;
let auth: DbClient;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;

const count = async (tenantId: string): Promise<number> => {
  const result = await superuser.query<{ n: string }>(
    'select count(*)::text as n from search_documents where tenant_id = $1',
    [tenantId],
  );
  return Number(result.rows[0]?.n ?? 0);
};

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  auth = createDbClient({ connectionString: urls.auth, maxConnections: 2 });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  const fixtures = new Fixtures(superuser);

  tenantA = (await fixtures.createTenant({ name: 'Reindex A' })).tenantId;
  tenantB = (await fixtures.createTenant({ name: 'Reindex B' })).tenantId;
  // Records written straight in, as a restore or a script would: nothing indexed them.
  await fixtures.createContact(tenantA, { lastName: 'Alderwood', email: 'a@one.example' });
  await fixtures.createContact(tenantA, { lastName: 'Briarwood', email: 'b@one.example' });
  await fixtures.createContact(tenantB, { lastName: 'Cottonwood', email: 'c@two.example' });
  // A record in the Recycle Bin must not come back.
  await superuser.query(
    `insert into contacts (id, tenant_id, last_name, deleted_at)
     values (gen_random_uuid(), $1, 'Deletedwood', now())`,
    [tenantA],
  );
});

afterAll(async () => {
  await Promise.all([worker.close(), auth.close(), superuser.end()]);
});

describe('reindexing one company', () => {
  it('indexes that company and leaves every other alone', async () => {
    expect(await count(tenantA)).toBe(0);
    expect(await count(tenantB)).toBe(0);

    const summary = await reindexAll({ worker, auth: null }, { tenantId: tenantA });

    expect(summary).toMatchObject({ tenants: 1, failed: [] });
    expect(await count(tenantA)).toBeGreaterThan(0);
    expect(await count(tenantB)).toBe(0);
  });

  it('does not bring back a record that is in the Recycle Bin', async () => {
    const result = await superuser.query(
      `select 1 from search_documents where tenant_id = $1 and value = 'Deletedwood'`,
      [tenantA],
    );
    expect(result.rowCount).toBe(0);
  });

  it('is idempotent: running it again leaves exactly the same rows', async () => {
    const before = await count(tenantA);
    await reindexAll({ worker, auth: null }, { tenantId: tenantA });
    expect(await count(tenantA)).toBe(before);
  });

  it('removes what no longer exists, rather than only adding', async () => {
    await superuser.query(
      `insert into search_documents
         (id, tenant_id, object_type, record_id, field_key, owner_id, value, weight, record_updated_at)
       values (gen_random_uuid(), $1, 'contact', gen_random_uuid(), 'last_name', null, 'Ghostwood', 'A', now())`,
      [tenantA],
    );
    await reindexAll({ worker, auth: null }, { tenantId: tenantA });
    const result = await superuser.query(
      `select 1 from search_documents where tenant_id = $1 and value = 'Ghostwood'`,
      [tenantA],
    );
    expect(result.rowCount).toBe(0);
  });
});

describe('reindexing every company', () => {
  it('lists the companies with the auth role and rebuilds each', async () => {
    const summary = await reindexAll({ worker, auth });
    expect(summary.failed).toEqual([]);
    expect(summary.tenants).toBeGreaterThanOrEqual(2);
    expect(await count(tenantB)).toBeGreaterThan(0);
  });

  it('refuses, saying why, without the auth role and without a company named', async () => {
    await expect(reindexAll({ worker, auth: null })).rejects.toThrow(/DATABASE_AUTH_URL/);
  });

  it('reports a company that fails and carries on with the rest', async () => {
    const lines: string[] = [];
    // A company id that does not exist is not an error (nothing to index); one the worker cannot
    // read through is. A broken client stands in for a failure partway through a company.
    const broken = {
      db: {
        transaction: () => Promise.reject(new Error('connection lost')),
      },
    } as unknown as DbClient;
    const summary = await reindexAll({ worker: broken, auth }, {}, (line) => lines.push(line));
    expect(summary.tenants).toBe(0);
    expect(summary.failed.length).toBeGreaterThanOrEqual(2);
    expect(summary.failed[0]?.error).toContain('connection lost');
    expect(lines.some((line) => line.includes('FAILED'))).toBe(true);
    // A failed rebuild leaves the index as it was.
    expect(await count(tenantB)).toBeGreaterThan(0);
  });
});
