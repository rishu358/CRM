import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { createDbClient, withTenant, type DbClient } from './client.js';
import { Fixtures } from './testing/fixtures.js';

/**
 * The dashboard's "won this month" query shape (MVP_SPEC M10, ADR-0038).
 *
 * What decides whether this stays inside its budget as a company ages is not how
 * long the query takes on a fixture but **how many rows it reads to find the
 * month's wins**: with the stage index alone it reads every deal the company has
 * ever won. The plan shows that at any size, so this builds a company whose wins
 * are spread over three years and asserts on the plan of the statement the API
 * issues, not on a stopwatch.
 */
let client: DbClient;
let superuser: pg.Pool;
let tenantId: string;
let wonStage: string;

const OPEN_DEALS = 30_000;
const WON_DEALS = 3_000;

beforeAll(async () => {
  const urls = inject('dbUrls');
  client = createDbClient({ connectionString: urls.app, maxConnections: 2 });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  const fixtures = new Fixtures(superuser);

  tenantId = (await fixtures.createTenant({ name: 'Dashboard plan' })).tenantId;
  const roleId = await fixtures.createRole(tenantId, 'Plan role');
  const owner = (await fixtures.createUser(tenantId, roleId)).userId;
  const pipeline = await fixtures.createPipeline(tenantId, 'Plan pipeline', [
    { name: 'Open', stageType: 'open', probability: 10 },
    { name: 'Won', stageType: 'won', probability: 100 },
  ]);
  const openStage = pipeline.stageIds[0]!;
  wonStage = pipeline.stageIds[1]!;

  await superuser.query(
    `insert into deals
       (id, tenant_id, owner_id, name, pipeline_id, stage_id, amount_minor, currency,
        probability, closed_at)
     select gen_random_uuid(), $1, $2, 'Open ' || g, $3, $4, 1000, 'INR', 10, null
     from generate_series(1, $5::int) g`,
    [tenantId, owner, pipeline.pipelineId, openStage, OPEN_DEALS],
  );
  // Wins from now back three years, evenly, so a two-month window holds about 5%.
  await superuser.query(
    `insert into deals
       (id, tenant_id, owner_id, name, pipeline_id, stage_id, amount_minor, currency,
        probability, closed_at)
     select gen_random_uuid(), $1, $2, 'Won ' || g, $3, $4, 1000, 'INR', 100,
            now() - make_interval(days => (g * 1095 / $5::int))
     from generate_series(1, $5::int) g`,
    [tenantId, owner, pipeline.pipelineId, wonStage, WON_DEALS],
  );
  await superuser.query('analyze deals');
});

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

describe('deals won in a two-month window', () => {
  // The predicates of `DealsRepository.wonCells`, without the scope.
  const wonInWindow = () => sql`
    select d.owner_id, d.currency, count(*), sum(d.amount_minor)
    from deals d
    where d.tenant_id = ${tenantId}::uuid
      and d.deleted_at is null
      and d.stage_id in (${wonStage}::uuid)
      and d.closed_at >= date_trunc('month', now()) - interval '1 month'
      and d.closed_at < date_trunc('month', now()) + interval '1 month'
    group by 1, 2
  `;

  it('reads an index, not the table', async () => {
    const plan = await planFor(wonInWindow());
    expect(plan).not.toMatch(/Seq Scan on deals/);
    expect(plan).toMatch(/deals_tenant_closed_idx/);
  });

  it('reads about the window, not every deal ever won', async () => {
    const plan = await planFor(wonInWindow());
    // Rows the scan returned before any filter threw them away: two months is
    // about 5% of three years. Allow for the planner choosing a bitmap scan.
    const scans = [
      ...plan.matchAll(/(?:Index|Bitmap Heap) Scan[^\n]*actual time=[^\n]*rows=(\d+)/g),
    ];
    expect(scans.length).toBeGreaterThan(0);
    const read = Math.max(...scans.map((match) => Number(match[1])));
    expect(read).toBeLessThan(WON_DEALS / 4);
  });
});
