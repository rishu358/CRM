import { newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbClient, withTenant, type DbClient } from './client.js';
import { Fixtures } from './testing/fixtures.js';
import { sql } from 'drizzle-orm';
import pg from 'pg';

/**
 * The audit viewer's query shape (MVP_SPEC M11, ADR-0034).
 *
 * `audit_logs` is partitioned monthly by `occurred_at` and will be the largest
 * table in the database. The viewer's filters are therefore not a detail of the
 * repository: whether a filter lands on the partition key and an index, or on a
 * scan, is the difference between a page and an outage on a tenant with four
 * years of history.
 *
 * A test cannot usefully build four years of real history, and would not learn
 * much more if it did — what decides whether the query stays inside its budget
 * as a tenant grows is **which partitions it opens and whether it reads an
 * index**, and that is visible in the plan at any size. So this file asserts the
 * plan of the statements the repository actually issues:
 *
 *   1. a bounded window prunes to the partitions that can contain it;
 *   2. an unbounded one does not — which is why the API never sends one;
 *   3. the actor, object and action filters each reach an index.
 *
 * The rows are inserted across several months so that pruning has something to
 * prune. Written here rather than in the API suite because the question is
 * about the schema and the planner, not about the endpoint.
 */
let client: DbClient;
let rawSuperuser: pg.Pool;
let migrator: pg.Pool;
let fixtures: Fixtures;
let tenantId: string;
let actorId: string;
/** Everybody else who acted, so that filtering by `actorId` is selective. */
let otherActorIds: string[] = [];

/** One row in each of several months, including months outside every window. */
const MONTH_OFFSETS = [0, -1, -2, -3, -5, -8, -11];

beforeAll(async () => {
  const urls = inject('dbUrls');
  client = createDbClient({ connectionString: urls.app, maxConnections: 2 });
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  migrator = new pg.Pool({ connectionString: urls.migrator, max: 1 });
  fixtures = new Fixtures(rawSuperuser);

  tenantId = (await fixtures.createTenant({ name: 'Audit plan' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Plan role');
  actorId = (await fixtures.createUser(tenantId, roleId)).userId;
  // An index is only worth choosing if the filter it serves throws most rows
  // away. With one actor on every row, `actor_id = X` keeps 100% of them and the
  // planner is right to prefer the tenant-and-time index — so a test that
  // demands the actor index would pass or fail on how the random timestamps
  // happened to fall. Nineteen other people share the log with the actor under
  // test, so their filter keeps about one row in twenty.
  otherActorIds = [];
  for (let n = 0; n < 19; n += 1) {
    otherActorIds.push((await fixtures.createUser(tenantId, roleId)).userId);
  }

  // 0003 bootstraps partitions from last month forward, so the older months
  // this test needs do not exist yet and their rows would land in
  // `audit_logs_default` — where nothing can be pruned. Creating them here is
  // what the rolling-window job will do in production. Created as crm_migrator,
  // which owns every table: a partition owned by the superuser would be caught
  // by the RLS suite's "owns no tables" check, and rightly, since the suites
  // share one database.
  for (const offset of MONTH_OFFSETS) {
    await migrator.query(
      `do $$
       declare
         start_month date := (date_trunc('month', now() + make_interval(months => $1::int)))::date;
       begin
         execute format(
           'create table if not exists %I partition of audit_logs for values from (%L) to (%L)',
           'audit_logs_' || to_char(start_month, 'YYYY_MM'),
           start_month,
           (start_month + interval '1 month')::date
         );
       end $$;`.replace('$1::int', String(offset)),
    );
  }

  // Enough rows per month that the planner has a real choice rather than
  // "this partition is one page, read it".
  for (const offset of MONTH_OFFSETS) {
    const values = Array.from({ length: 400 }, () => newId());
    await rawSuperuser.query(
      `insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id, occurred_at, changes)
       select v.id, $2,
              (array[$3::uuid] || $5::uuid[])[1 + (v.n % 20)::int],
              'update', 'contact', gen_random_uuid(),
              now() + make_interval(months => $4) - make_interval(mins => (random() * 1000)::int),
              '{"lastName": {"old": "a", "new": "b"}}'::jsonb
       from unnest($1::uuid[]) with ordinality as v(id, n)`,
      [values, tenantId, actorId, offset, otherActorIds],
    );
  }
  await rawSuperuser.query('analyze audit_logs');
});

afterAll(async () => {
  await client.close();
  await Promise.all([rawSuperuser.end(), migrator.end()]);
});

/** The plan, as the application role sees it — RLS included. */
async function planFor(statement: ReturnType<typeof sql>): Promise<string> {
  return withTenant(client.db, { tenantId, userId: null }, async (tx) => {
    const result = await tx.execute(sql`explain (analyze, format text) ${statement}`);
    return (result.rows as unknown as { 'QUERY PLAN': string }[])
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  });
}

/** How many `audit_logs_YYYY_MM` partitions the plan actually opened. */
function partitionsOpened(plan: string): string[] {
  return [...new Set(plan.match(/audit_logs_\d{4}_\d{2}/g) ?? [])];
}

describe('partition pruning (ADR-0034)', () => {
  it('a bounded window opens only the months it covers', async () => {
    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
        and a.occurred_at >= now() - interval '20 days'
        and a.occurred_at < now()
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    // A 20-day window spans at most two calendar months.
    expect(partitionsOpened(plan).length).toBeLessThanOrEqual(2);
  });

  it('an unbounded query opens many months — which is why the API never sends one', async () => {
    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    // The negative case, asserted rather than assumed: if this ever started
    // pruning on its own, the default window would stop being load-bearing and
    // somebody should find out from a test rather than from production.
    expect(partitionsOpened(plan).length).toBeGreaterThan(2);
  });
});

describe('the filters reach an index', () => {
  it('tenant and window use an index rather than scanning a partition', async () => {
    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
        and a.occurred_at >= now() - interval '20 days'
        and a.occurred_at < now()
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toMatch(/Seq Scan on audit_logs_\d{4}_\d{2}/);
  });

  it('filtering by actor uses the actor index', async () => {
    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
        and a.occurred_at >= now() - interval '20 days'
        and a.occurred_at < now()
        and a.actor_id = ${actorId}::uuid
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    // Postgres names each partition's index after the partition and its
    // columns, so the parent's name never appears in a plan.
    expect(plan).toContain('tenant_id_actor_id_occurred_at_idx');
  });

  it('filtering by object type uses the index migration 0016 added for it', async () => {
    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
        and a.occurred_at >= now() - interval '60 days'
        and a.occurred_at < now()
        and a.object_type = 'contact'
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    expect(plan).toContain('tenant_id_object_type_occurred_at_idx');
    expect(plan).not.toMatch(/Seq Scan on audit_logs_\d{4}_\d{2}/);
  });

  it("one record's history uses the record index", async () => {
    const recordId = (
      await rawSuperuser.query<{ record_id: string }>(
        'select record_id from audit_logs where tenant_id = $1 limit 1',
        [tenantId],
      )
    ).rows[0]!.record_id;

    const plan = await planFor(sql`
      select a.id
      from audit_logs a
      where a.tenant_id = ${tenantId}::uuid
        and a.occurred_at >= now() - interval '400 days'
        and a.occurred_at < now()
        and a.object_type = 'contact'
        and a.record_id = ${recordId}::uuid
      order by a.occurred_at desc, a.id desc
      limit 50
    `);

    expect(plan).toContain('tenant_id_object_type_record_id_idx');
  });
});
