import { newId } from '@crm/core';
import {
  createDbClient,
  loadSampleData,
  PostgresSearchProvider,
  withTenant,
  type DbClient,
} from '@crm/db';
import { provisionTenantDefaults } from '@crm/db/seed';
import { Fixtures } from '@crm/db/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../relay.js';
import { drainRelay } from '../testing/drain.js';
import { indexSearchDocument, removeSearchDocument } from './search.js';
import { removeSampleDataJob } from './sample-data.js';
import { projectTimeline } from './timeline.js';

/**
 * Removing sample data, end to end through the real relay (MVP_SPEC M2,
 * ADR-0037).
 *
 * The library's own suite proves *what* is removed. What only a relay can prove
 * is the part around it: that loading leaves records the search index and the
 * timelines pick up, that removal then clears those too, that a requester whose
 * rights were withdrawn in between gets nothing deleted, and that a redelivered
 * event is harmless. Every statement here goes through the real claim, the
 * tenant-scoped transaction and the real handlers, not a direct call.
 */
const logger = pino({ level: 'silent' });
const provider = new PostgresSearchProvider();
const TOTAL = 20;

let app: DbClient;
let worker: DbClient;
let su: pg.Pool;
let fixtures: Fixtures;

beforeAll(() => {
  const urls = inject('dbUrls');
  app = createDbClient({ connectionString: urls.app, maxConnections: 4 });
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  su = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(su);
});

afterAll(async () => {
  await Promise.all([app.close(), worker.close(), su.end()]);
});

interface Workspace {
  readonly tenantId: string;
  readonly userId: string;
  readonly repRoleId: string;
}

async function workspace(): Promise<Workspace> {
  const tenantId = (await fixtures.createTenant({ name: `Setup ${newId().slice(-8)}` })).tenantId;
  const provisioned = await withTenant(app.db, { tenantId, userId: null }, (tx) =>
    provisionTenantDefaults(tx, tenantId, null),
  );
  const userId = (await fixtures.createUser(tenantId, provisioned.roleIdsByName.get('Owner')!))
    .userId;
  return { tenantId, userId, repRoleId: provisioned.roleIdsByName.get('Sales Rep')! };
}

/** The relay as `main.ts` wires it for everything sample data touches. */
function relay(): OutboxRelay {
  const instance = new OutboxRelay(worker.db, { logger, batchSize: 100 });
  for (const type of ['account', 'contact', 'lead', 'deal', 'activity'] as const) {
    instance.on(`${type}.created.v1`, indexSearchDocument(provider));
    instance.on(`${type}.purged.v1`, removeSearchDocument(provider));
  }
  return instance
    .on('contact.created.v1', projectTimeline)
    .on('deal.created.v1', projectTimeline)
    .on('lead.created.v1', projectTimeline)
    .on('activity.linked.v1', projectTimeline)
    .on('sample_data.removal_requested.v1', removeSampleDataJob({ logger }));
}

const drain = () => drainRelay(relay(), { query: (text) => su.query(text) }, { limit: 200 });

async function load(w: Workspace): Promise<void> {
  await withTenant(app.db, { tenantId: w.tenantId, userId: w.userId }, (tx) =>
    loadSampleData(tx, { tenantId: w.tenantId, actorId: w.userId, currency: 'INR' }),
  );
}

/** What the API does when somebody presses "Remove sample data". */
async function requestRemoval(w: Workspace, requester: string | null = w.userId): Promise<void> {
  await su.query(
    `insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, actor_id)
     values ($1, $2, 'sample_data.removal_requested.v1', 'tenant', $2, '{}'::jsonb, $3)`,
    [newId(), w.tenantId, requester],
  );
}

async function count(text: string, params: unknown[]): Promise<number> {
  const result = await su.query<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(result.rows[0]?.n ?? '0');
}

// The index holds a row per searchable *field* (ADR-0028), so a record has several;
// what matters is how many records can be found, not how many rows say so.
const searchable = (w: Workspace) =>
  count(
    '(select distinct object_type, record_id from search_documents where tenant_id = $1) as found',
    [w.tenantId],
  );
const timeline = (w: Workspace) => count('timeline_events where tenant_id = $1', [w.tenantId]);
const records = (w: Workspace) =>
  count(
    `(select id from accounts where tenant_id = $1 union all select id from contacts where tenant_id = $1
      union all select id from leads where tenant_id = $1 union all select id from deals where tenant_id = $1
      union all select id from activities where tenant_id = $1) as r`,
    [w.tenantId],
  );

describe('what loading leaves for the worker to pick up', () => {
  it('is searchable and on timelines once the relay has run, like any record', async () => {
    const w = await workspace();
    await load(w);
    await drain();

    expect(await searchable(w)).toBe(TOTAL);
    // Contacts, deals and leads say they were created, and each task is on the
    // timeline of the record it is about.
    expect(await timeline(w)).toBeGreaterThanOrEqual(13 + 4);
    const showroom = (
      await su.query<{ id: string }>(
        `select id from deals where tenant_id = $1 and name like 'Showroom%'`,
        [w.tenantId],
      )
    ).rows[0]!.id;
    expect(
      (await fixtures.timelineFor(w.tenantId, 'deal', showroom)).map((e) => e.eventType),
    ).toContain('deal.created.v1');
  });
});

describe('removal through the relay', () => {
  it('takes the records, their search entries and their timelines with it', async () => {
    const w = await workspace();
    await load(w);
    await drain();
    expect(await searchable(w)).toBe(TOTAL);

    await requestRemoval(w);
    await drain();

    expect(await records(w)).toBe(0);
    expect(await count('sample_records where tenant_id = $1', [w.tenantId])).toBe(0);
    expect(await searchable(w)).toBe(0);
    expect(await timeline(w)).toBe(0);
    expect(await count('activity_links where tenant_id = $1', [w.tenantId])).toBe(0);
    // The relay consumed the request: nothing is left pending to be retried.
    expect(
      await count(
        `outbox_events where tenant_id = $1 and event_type = 'sample_data.removal_requested.v1' and status <> 'relayed'`,
        [w.tenantId],
      ),
    ).toBe(0);
  });

  it('keeps an edited record findable and on its timeline, and removes the rest', async () => {
    const w = await workspace();
    await load(w);
    await drain();
    const gupta = (
      await su.query<{ id: string }>(
        `select id from contacts where tenant_id = $1 and last_name like 'Gupta%'`,
        [w.tenantId],
      )
    ).rows[0]!.id;
    await su.query(`update contacts set version = version + 1 where id = $1`, [gupta]);

    await requestRemoval(w);
    await drain();

    expect(await count('contacts where id = $1', [gupta])).toBe(1);
    expect(await count('search_documents where record_id = $1', [gupta])).toBeGreaterThan(0);
    // Everything else about it is gone, and nothing else stayed findable by accident.
    const stillFindable = await su.query<{ record_id: string }>(
      `select record_id::text from search_documents where tenant_id = $1`,
      [w.tenantId],
    );
    const live = await su.query<{ id: string }>(
      `select id::text from contacts where tenant_id = $1
       union all select id::text from accounts where tenant_id = $1`,
      [w.tenantId],
    );
    const liveIds = new Set(live.rows.map((row) => row.id));
    for (const row of stillFindable.rows)
      expect(liveIds.has(row.record_id), row.record_id).toBe(true);
  });

  it('deletes nothing when the person who asked can no longer change company setup', async () => {
    const w = await workspace();
    await load(w);
    await drain();
    // Between the click and the job, they are made a sales rep.
    await su.query(`update memberships set role_id = $3 where tenant_id = $1 and user_id = $2`, [
      w.tenantId,
      w.userId,
      w.repRoleId,
    ]);

    await requestRemoval(w);
    await drain();

    expect(await records(w)).toBe(TOTAL);
    expect(await count('sample_records where tenant_id = $1', [w.tenantId])).toBe(TOTAL);
    expect(await searchable(w)).toBe(TOTAL);
    // Consumed, not retried forever: a refused request is an answer.
    expect(
      await count(
        `outbox_events where tenant_id = $1 and event_type = 'sample_data.removal_requested.v1' and status <> 'relayed'`,
        [w.tenantId],
      ),
    ).toBe(0);
  });

  it('does nothing for a request that names nobody', async () => {
    const w = await workspace();
    await load(w);

    await requestRemoval(w, null);
    await drain();

    expect(await records(w)).toBe(TOTAL);
  });

  it('is harmless when the same request is delivered twice', async () => {
    const w = await workspace();
    await load(w);
    await drain();

    await requestRemoval(w);
    await requestRemoval(w);
    await drain();

    expect(await records(w)).toBe(0);
    // One summary, from the delivery that did the work. The second found an empty
    // registry and said nothing, which is the right amount to say.
    const summaries = await su.query<{ changes: { removed: { new: { accounts: number } } } }>(
      `select changes from audit_logs
       where tenant_id = $1 and action = 'sample_data_removed'`,
      [w.tenantId],
    );
    expect(summaries.rows).toHaveLength(1);
    expect(summaries.rows[0]?.changes.removed.new.accounts).toBe(3);
  });

  it("never touches another company's sample data", async () => {
    const a = await workspace();
    const b = await workspace();
    await load(a);
    await load(b);
    await drain();

    await requestRemoval(a);
    await drain();

    expect(await records(a)).toBe(0);
    expect(await records(b)).toBe(TOTAL);
    expect(await searchable(b)).toBe(TOTAL);
    expect(await count('sample_records where tenant_id = $1', [b.tenantId])).toBe(TOTAL);
  });
});
