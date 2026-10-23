import { newId, type SearchObjectScope, type Uuid } from '@crm/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbClient, withTenant, type DbClient } from './client.js';
import { SEARCH_CANDIDATE_CAP, fullTextStatement, fuzzyStatement } from './search/postgres.js';
import { PostgresSearchProvider } from './search/postgres.js';
import { visibilityPredicate } from './search/postgres.js';
import { Fixtures } from './testing/fixtures.js';
import { sql } from 'drizzle-orm';

/**
 * The latency budget, and the plan behind it (MVP_SPEC §9, ADR-0028 §4).
 *
 * MVP_SPEC asks for results in under 300 ms for a tenant with 1M records. A
 * test cannot usefully build 1M records on every run, and would not learn
 * much more if it did: what decides whether this query stays inside the
 * budget as a tenant grows is **whether it reads an index or the table**, and
 * that is visible at a hundred thousand rows exactly as it is at four
 * million. So this file does two things:
 *
 *   1. asserts the plan — the real statement the provider runs, through
 *      EXPLAIN — uses the GIN indexes and does not scan `search_documents`;
 *   2. measures the query at a size large enough for the planner to have a
 *      genuine choice, and holds it to the budget.
 *
 * What would break it is written down in ADR-0028 §4 and visible here: the
 * cost of a GIN lookup is proportional to **how many entries match**, not to
 * how large the table is. A selective term stays flat as the tenant grows; a
 * term that matches a large fraction of a tenant's rows does not, because
 * every match has to be ranked before the top ten can be known. The two
 * measurements below are deliberately one of each.
 */

/**
 * 50,000 records, four indexed fields each: 200,000 index rows, plus a second
 * tenant's 80,000 so the tenant predicate has something to exclude.
 *
 * Chosen as the smallest size at which the planner's choice is real rather
 * than "the table fits on a page, scan it" — and small enough to build in
 * seconds.
 */
const RECORDS = 50_000;
const OTHER_TENANT_RECORDS = 20_000;

/** MVP_SPEC §9. */
const BUDGET_MS = 300;

let worker: DbClient;
let superuserPool: pg.Pool;
let tenantId: string;
let otherTenantId: string;

const provider = new PostgresSearchProvider();

/** An `all`-scope reader who may read every searchable field on a contact. */
const WIDE_OPEN: readonly SearchObjectScope[] = [
  {
    objectType: 'contact',
    constraint: { kind: 'all' },
    fieldKeys: ['first_name', 'last_name', 'email', 'phone'],
  },
];

/** A rep on `own` scope: the same query plus an owner predicate. */
const OWN_SCOPE = (userId: string): readonly SearchObjectScope[] => [
  {
    objectType: 'contact',
    constraint: { kind: 'own', userId: userId as Uuid },
    fieldKeys: ['first_name', 'last_name', 'email', 'phone'],
  },
];

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  const fixtures = new Fixtures(superuserPool);

  tenantId = (await fixtures.createTenant({ name: 'Perf' })).tenantId;
  otherTenantId = (await fixtures.createTenant({ name: 'Perf B' })).tenantId;

  await seed(tenantId, RECORDS);
  await seed(otherTenantId, OTHER_TENANT_RECORDS);

  // Without statistics the planner is guessing, and a plan assertion against
  // a guess tells you nothing about production.
  await superuserPool.query('analyze search_documents');
}, 300_000);

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

/**
 * Index rows straight in, rather than through records and the relay.
 *
 * This file is about the shape of the read, and `search_documents` is a
 * projection whose contents are tested where they are produced
 * (`apps/worker/src/handlers/search.spec.ts`). The values are shaped like the
 * real thing — surnames repeat across a few dozen people, first names across
 * thousands, addresses share a domain — because selectivity is the whole
 * subject and uniformly unique tokens would make every query look fast.
 */
/**
 * A team of forty, so a rep's own records are a fortieth of the tenant, as in production. One owner
 * for every row would make `owner_id` either everything or (for a stranger) nothing, and the
 * planner's choice about an index on it means something only in between.
 */
const OWNERS = Array.from({ length: 40 }, () => newId());

async function seed(tenant: string, count: number): Promise<void> {
  await superuserPool.query(
    `insert into search_documents
       (id, tenant_id, object_type, record_id, field_key, owner_id, value, weight,
        record_updated_at)
     select gen_random_uuid(), $1, 'contact', record_id, field.key, ($2::uuid[])[1 + (r.n % 40)], field.value,
            field.weight, now()
     from (
       select n, gen_random_uuid() as record_id from generate_series(1, $3) as n
     ) as r
     cross join lateral (values
       ('first_name',
        (array['Anjali','Rahul','Priya','Vikram','Fatima','Joseph','Meera','Imran',
               'Divya','Arjun','Neha','Sanjay','Kavya','Rohit','Zoya','Aditya',
               'Lakshmi','Farhan','Ishita','Manish'])[1 + (r.n % 20)],
        'A'),
       ('last_name', 'Surname' || (r.n % 2000)::text, 'A'),
       ('email', 'person' || r.n::text || '@firm' || (r.n % 500)::text || '.example', 'B'),
       ('phone', '+9190' || lpad(r.n::text, 8, '0'), 'C')
     ) as field(key, value, weight)`,
    [tenant, OWNERS, count],
  );
}

/** The plan Postgres produces for a statement, as text. */
async function planFor(statement: ReturnType<typeof fullTextStatement>): Promise<string> {
  const result = await withTenant(worker.db, { tenantId, userId: null }, (tx) =>
    tx.execute(sql`explain (analyze, buffers, format json) ${statement}`),
  );
  return JSON.stringify((result.rows as unknown as { 'QUERY PLAN': unknown }[])[0]);
}

/** Median of several runs, so one cold call does not decide the verdict. */
async function medianMs(run: () => Promise<unknown>, attempts = 5): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < attempts; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function search(term: string, scopes: readonly SearchObjectScope[] = WIDE_OPEN) {
  return withTenant(worker.db, { tenantId, userId: null }, (tx) =>
    provider.search(tx, { tenantId: tenantId as Uuid, term, limit: 10, scopes }),
  );
}

/**
 * The Postgres major version the LEAKPROOF reasoning in ADR-0028 §7 was done
 * against (16.6, where neither operator is leakproof in core and neither has a
 * data-dependent error path).
 *
 * §7 is an argument about the current implementation of two functions, and the
 * assertion below only notices the marking being *removed* — it cannot notice
 * an operator gaining an error path in a newer release, which is the case that
 * would actually matter. This constant is how a major upgrade stops here.
 * Change it only after re-checking both operators, in the same change as the
 * new image in `docker-compose.yml` and the Testcontainers harness.
 */
const REVIEWED_POSTGRES_MAJOR = 16;

describe('the two operators the plan depends on', () => {
  it('runs on the Postgres major version the LEAKPROOF analysis covers', async () => {
    const result = await superuserPool.query<{ major: number }>(
      `select (current_setting('server_version_num')::int / 10000) as major`,
    );
    const actual = result.rows[0]?.major;
    expect(
      actual,
      `Postgres is ${String(actual)}.x but ADR-0028 §7 marks ts_match_vq and ` +
        `word_similarity_op LEAKPROOF on the strength of an analysis of ` +
        `${String(REVIEWED_POSTGRES_MAJOR)}.x. Re-check both operators for ` +
        `data-dependent error paths on ${String(actual)}.x, then update ` +
        `REVIEWED_POSTGRES_MAJOR.`,
    ).toBe(REVIEWED_POSTGRES_MAJOR);
  });

  it('still has `@@` and `<%` marked LEAKPROOF', async () => {
    // Not a style assertion. A table with Row-Level Security is a security
    // barrier, and Postgres will not evaluate a qual that is not leakproof
    // before the policy has filtered the rows — which means such a qual can
    // never become an index condition. Without these two markings the
    // planner is reduced to a sequential scan of `search_documents`, and the
    // four plan assertions below fail in a way that looks like a planner
    // mood rather than a missing line in the bootstrap (ADR-0028 §7).
    const result = await superuserPool.query<{ proname: string; proleakproof: boolean }>(
      `select proname, proleakproof from pg_proc
       where proname in ('ts_match_vq', 'word_similarity_op')`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of result.rows) {
      expect(
        row.proleakproof,
        `${row.proname} is no longer LEAKPROOF: see packages/db/sql/bootstrap and ADR-0028 §7. ` +
          'Search will fall back to a sequential scan under RLS.',
      ).toBe(true);
    }
  });
});

describe('the query plan', () => {
  it('reads the full-text GIN index rather than the table', async () => {
    const plan = await planFor(
      fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(WIDE_OPEN), 10),
    );

    expect(plan).toContain('search_documents_fts_idx');
    expect(plan).toContain('Bitmap Index Scan');
    // The assertion that matters: at a million records a sequential scan of
    // this table is the difference between 20 ms and several seconds.
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
  });

  it('puts the tenant inside the index condition, not in a recheck', async () => {
    // This is what btree_gin buys. Without `tenant_id` as a leading index
    // column, every tenant's matches for a term would be fetched and then
    // thrown away — work proportional to the whole platform rather than to
    // one customer, and the first thing to fall over at a thousand tenants.
    const plan = await planFor(
      fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(WIDE_OPEN), 10),
    );
    const condition = /"Index Cond":"([^"]*)"/.exec(plan)?.[1] ?? '';
    expect(condition).toContain('tenant_id');
    expect(condition).toContain('search_vector');
  });

  it('reads the trigram GIN index for the fuzzy pass', async () => {
    const plan = await planFor(
      fuzzyStatement(tenantId, 'surnam1234', visibilityPredicate(WIDE_OPEN), 10),
    );

    expect(plan).toContain('search_documents_trgm_idx');
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
  });

  it('still reads the index when a rep record scope narrows the query', async () => {
    // The owner predicate is a filter on top of the index scan, not a reason
    // to abandon it. A rep's palette must not be slower than an admin's.
    const scopes = OWN_SCOPE(OWNERS[0]!);
    const plan = await planFor(
      fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(scopes), 10),
    );

    expect(plan).toContain('search_documents_fts_idx');
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
  });

  it('makes the rep own-scope owner an index condition, so a rep reads their own rows', async () => {
    // Measured at a million contacts: a rep's common-surname search took 1.5 to 3 s when the owner
    // was a filter applied after every match was fetched, and about 0.15 s when it is part of the
    // index condition. The owner only becomes one if it is stated outside the OR of per-object
    // blocks as well as inside it (migration 0021, ADR-0041).
    const plan = await planFor(
      fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(OWN_SCOPE(OWNERS[0]!)), 10),
    );
    const conditions = [...plan.matchAll(/"Index Cond":"([^"]*)"/g)].map((match) => match[1] ?? '');
    expect(conditions.some((condition) => condition.includes('owner_id'))).toBe(true);
  });

  it('does not invent an owner condition when any object is searched at wider scope', async () => {
    // One block `all`, one `own`: the wider block must still match other people's rows.
    const mixed: readonly SearchObjectScope[] = [
      ...WIDE_OPEN,
      { ...OWN_SCOPE(OWNERS[0]!)[0]!, objectType: 'account' },
    ];
    const plan = await planFor(
      fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(mixed), 10),
    );
    const conditions = [...plan.matchAll(/"Index Cond":"([^"]*)"/g)].map((match) => match[1] ?? '');
    expect(conditions.every((condition) => !condition.includes('owner_id'))).toBe(true);
    // And the wide block still finds the (differently owned) contacts.
    const hits = await search('Surname1234', mixed);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('a broad term is bounded', () => {
  // 20 first names over 50,000 records: each name is 2,500 index rows, far above the cap.
  const broad = ['anjali'];

  it('can walk the matches newest first from the recency index and stop at the cap', async () => {
    // At fifty thousand records a broad term matches 2,500 rows and the planner is right to prefer the
    // bitmap scan; the recency index wins where it matters, at hundreds of thousands (measured at a
    // million contacts: 5.7 s down to 0.18 s). So this steers the planner to it and asserts what the
    // index must be able to do: serve the statement's own ordering, so the scan stops at the cap
    // rather than reading every match.
    const plan = await withTenant(worker.db, { tenantId, userId: null }, async (tx) => {
      await tx.execute(sql`set local enable_bitmapscan = off`);
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute(
        sql`explain (analyze, format json) ${fullTextStatement(tenantId, broad, visibilityPredicate(WIDE_OPEN), 10)}`,
      );
      return JSON.stringify((result.rows as unknown as { 'QUERY PLAN': unknown }[])[0]);
    });
    expect(plan).toContain('search_documents_recent_idx');

    // Every node of the plan, flattened.
    interface PlanNode {
      'Node Type'?: string;
      'Index Name'?: string;
      'Actual Rows'?: number;
      'Sort Key'?: string[];
      Plans?: PlanNode[];
    }
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode): void => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk((JSON.parse(plan) as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0]!.Plan);

    // The index already delivers the matches in the statement's order, so nothing sorts them all...
    const sortsEveryMatch = nodes.some((node) =>
      (node['Sort Key'] ?? []).some((key) => key.startsWith('search_documents.record_updated_at')),
    );
    expect(sortsEveryMatch).toBe(false);
    // ...and the walk stops at the cap instead of reading every match.
    const walked = nodes.find((node) => node['Index Name'] === 'search_documents_recent_idx');
    expect(walked?.['Actual Rows']).toBeLessThanOrEqual(SEARCH_CANDIDATE_CAP);
  });

  it('never ranks more than the cap, however many rows match', async () => {
    const result = await withTenant(worker.db, { tenantId, userId: null }, (tx) =>
      // A limit above the cap, so what bounds the answer is the cap and not the limit.
      tx.execute(fullTextStatement(tenantId, broad, visibilityPredicate(WIDE_OPEN), 10_000)),
    );
    expect(result.rows.length).toBe(SEARCH_CANDIDATE_CAP);
  });

  it('leaves a selective term exactly as it was: every match is ranked', async () => {
    // `Surname1234` is 25 rows, well under the cap, so nothing may be dropped.
    const result = await withTenant(worker.db, { tenantId, userId: null }, (tx) =>
      tx.execute(
        fullTextStatement(tenantId, ['surname1234'], visibilityPredicate(WIDE_OPEN), 10_000),
      ),
    );
    expect(result.rows.length).toBe(RECORDS / 2000);
  });

  it('answers a broad term inside the budget', async () => {
    const elapsed = await medianMs(() => search('Anjali'));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('bounds the fuzzy pass the same way', async () => {
    const result = await withTenant(worker.db, { tenantId, userId: null }, (tx) =>
      tx.execute(fuzzyStatement(tenantId, 'anjalli', visibilityPredicate(WIDE_OPEN), 10_000)),
    );
    expect(result.rows.length).toBeLessThanOrEqual(SEARCH_CANDIDATE_CAP);
  });
});

describe('the latency budget', () => {
  it('answers a selective query well inside 300 ms', async () => {
    // What a command palette actually does: a surname, shared by a couple of
    // dozen people in a tenant of fifty thousand.
    const elapsed = await medianMs(() => search('Surname1234'));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('answers a two-word query inside the budget', async () => {
    const elapsed = await medianMs(() => search('Anjali Surname1234'));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('answers a prefix inside the budget', async () => {
    // Every term is a prefix (`surnam:*`), which widens the index lookup to
    // every token sharing that start — the normal case while somebody types.
    const elapsed = await medianMs(() => search('surname12'));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('answers a rep own-scope query inside the budget', async () => {
    const elapsed = await medianMs(() => search('Surname1234', OWN_SCOPE(OWNERS[0]!)));
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('finds the records it was supposed to find', async () => {
    // A fast query that returns nothing is not a passing performance test.
    const hits = await search('Surname1234');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.matchedFieldKey).toBe('last_name');
  });

  it('does not let another tenant rows into the measurement', async () => {
    // Both tenants hold `Surname1234`. If the predicate were applied after
    // the fact this would still pass functionally and be twice the work.
    const hits = await search('Surname1234');
    const rows = await withTenant(worker.db, { tenantId, userId: null }, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from search_documents where tenant_id <> ${tenantId}`,
      ),
    );
    expect((rows.rows as unknown as { n: number }[])[0]?.n).toBe(0);
    expect(hits.length).toBeGreaterThan(0);
  });
});
