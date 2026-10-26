import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { createDbClient, withTenant, type DbClient } from './client.js';
import { Fixtures } from './testing/fixtures.js';

/**
 * Exact email lookups under row-level security (migration 0020, ADR-0041).
 *
 * Found by the load test: `WHERE email = 'x'` read every contact a company has although an index on
 * `(tenant_id, email)` existed. `email` is `citext`, whose equality function is not LEAKPROOF, and
 * with RLS on Postgres will not use a non-leakproof function as an index condition. The fix is to
 * compare as text, which has an index of its own and a CHECK that makes the comparison exact.
 *
 * Like the other perf specs this asserts the *plan*, not a stopwatch: whether an index is read is
 * visible at fifty thousand rows exactly as at four million.
 */
let client: DbClient;
let superuser: pg.Pool;
let tenantId: string;

const CONTACTS = 50_000;

beforeAll(async () => {
  const urls = inject('dbUrls');
  client = createDbClient({ connectionString: urls.app, maxConnections: 2 });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  const fixtures = new Fixtures(superuser);
  tenantId = (await fixtures.createTenant({ name: 'Email lookup plan' })).tenantId;
  await superuser.query(
    `insert into contacts (id, tenant_id, last_name, email, created_at)
     select gen_random_uuid(), $1, 'Surname' || (g % 500), 'person' || g || '@example.com',
            now() - make_interval(secs => g)
     from generate_series(1, $2::int) g`,
    [tenantId, CONTACTS],
  );
  await superuser.query(
    `insert into leads (id, tenant_id, last_name, email, created_at)
     select gen_random_uuid(), $1, 'Surname' || (g % 500), 'lead' || g || '@example.com',
            now() - make_interval(secs => g)
     from generate_series(1, $2::int) g`,
    [tenantId, CONTACTS],
  );
  await superuser.query('analyze contacts');
  await superuser.query('analyze leads');
}, 120_000);

afterAll(async () => {
  await client.close();
  await superuser.end();
});

async function planFor(statement: ReturnType<typeof sql>): Promise<string> {
  return withTenant(client.db, { tenantId, userId: null }, async (tx) => {
    const result = await tx.execute(sql`explain (analyze, format text) ${statement}`);
    return (result.rows as unknown as { 'QUERY PLAN': string }[])
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  });
}

describe.each([
  ['contacts', 'contacts_tenant_email_text_idx'],
  ['leads', 'leads_tenant_email_text_idx'],
])('%s: an exact email lookup', (table, index) => {
  // The shape of `emailIs` in the list helpers and of the duplicate checks, with the keyset order.
  const textLookup = (value: string) =>
    sql`select id from ${sql.raw(table)}
        where tenant_id = ${tenantId}::uuid and deleted_at is null
          and email::text = ${value}
        order by created_at asc, id asc limit 50`;

  it('reads the text index, not the table', async () => {
    const plan = await planFor(textLookup('nobody.here@example.com'));
    expect(plan).toContain(index);
    expect(plan).not.toMatch(new RegExp(`Seq Scan on ${table}`));
  });

  it('finds the row, case folded by the caller, in a handful of buffers', async () => {
    const plan = await planFor(
      textLookup(`${table === 'contacts' ? 'person' : 'lead'}25000@example.com`),
    );
    expect(plan).toContain(index);
    expect(plan).toMatch(/rows=1\b/);
  });

  it('is the reason this exists: a citext comparison is never an index condition under RLS', async () => {
    // A canary, not a requirement. If a future Postgres marks citext equality leakproof this fails,
    // and the text comparison, its CHECK and its index can all be retired for the simpler query.
    const plan = await planFor(
      sql`select id from ${sql.raw(table)}
          where tenant_id = ${tenantId}::uuid and deleted_at is null
            and email = ${'nobody.here@example.com'}
          order by created_at asc, id asc limit 50`,
    );
    expect(plan).toMatch(new RegExp(`Seq Scan on ${table}`));
  });
});

describe('the lowercase guarantee the text comparison relies on', () => {
  it.each(['contacts', 'leads'])('%s refuses an email that is not lower case', async (table) => {
    await expect(
      superuser.query(
        `insert into ${table} (id, tenant_id, last_name, email)
         values (gen_random_uuid(), $1, 'Mixed', 'Mixed.Case@Example.com')`,
        [tenantId],
      ),
    ).rejects.toThrow(/lowercase_chk/);
  });

  it.each(['contacts', 'leads'])('%s refuses to be updated into one', async (table) => {
    await superuser.query(
      `insert into ${table} (id, tenant_id, last_name, email)
       values ('00000000-0000-7000-8000-0000000000aa', $1, 'Fine', 'fine@example.com')
       on conflict do nothing`,
      [tenantId],
    );
    await expect(
      superuser.query(
        `update ${table} set email = 'FINE@example.com' where id = '00000000-0000-7000-8000-0000000000aa'`,
      ),
    ).rejects.toThrow(/lowercase_chk/);
  });

  it.each(['contacts', 'leads'])('%s still allows no email at all', async (table) => {
    await superuser.query(
      `insert into ${table} (id, tenant_id, last_name, email)
       values (gen_random_uuid(), $1, 'No email', null)`,
      [tenantId],
    );
  });
});
