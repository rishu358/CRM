import { newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  startDataRightsHarness,
  type DataRightsHarness,
} from '../testing/data-rights-harness.js';
import { POLYMORPHIC_REFERENCE_TABLE_LIST } from './recycle-bin.js';

/**
 * The Recycle Bin purge job (MVP_SPEC M4).
 *
 * Three properties, each of which has a way of going wrong that a reading of
 * the code would not catch:
 *
 *   - it removes only what is **past retention**, and nothing live;
 *   - it is **idempotent**, because at-least-once delivery means it will run
 *     twice (ADR-0006);
 *   - it deals with **what soft delete left behind** — the polymorphic links,
 *     tags, timeline rows and recently-viewed entries that are deliberately
 *     kept while a record can still come back.
 *
 * Driven through the real relay, so the self-rearming schedule is exercised
 * too: the sweep is an outbox row that queues the next one (ADR-0025).
 */
let harness: DataRightsHarness;

/**
 * Rows from the superuser pool, named.
 *
 * `typedPool` returns `Record<string, unknown>[]` on purpose — `pg`'s default
 * `any[]` silently switches the type checker off for everything a test reads
 * back. This narrows at the call site instead, so each column still has to be
 * named explicitly.
 */
async function rowsOf<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  return (await harness.pool.query(text, values)).rows as T[];
}

async function deletedContact(options: {
  tenantId?: string;
  deletedDaysAgo: number;
  lastName?: string;
}): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into contacts (id, tenant_id, last_name, email, deleted_at)
     values ($1, $2, $3, $4, now() - make_interval(days => $5::int))`,
    [
      id,
      options.tenantId ?? harness.tenantId,
      options.lastName ?? 'Purgeable',
      `${newId().slice(0, 8)}@example.com`,
      options.deletedDaysAgo,
    ],
  );
  return id;
}

async function liveContact(tenantId?: string): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into contacts (id, tenant_id, last_name) values ($1, $2, 'Live')`,
    [id, tenantId ?? harness.tenantId],
  );
  return id;
}

async function contactExists(id: string): Promise<boolean> {
  const rows = await harness.pool.query('select 1 from contacts where id = $1', [id]);
  return rows.rows.length === 1;
}

async function countPendingSweeps(tenantId?: string): Promise<number> {
  const rows = await rowsOf<{ count: string }>(
    `select count(*)::text as count from outbox_events
     where tenant_id = $1 and event_type = 'recycle_bin.sweep_due.v1' and status = 'pending'`,
    [tenantId ?? harness.tenantId],
  );
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  harness = await startDataRightsHarness(inject('dbUrls'), { name: 'Purge' });
});

afterAll(async () => {
  await harness.close();
});

describe('what the sweep removes', () => {
  it('removes records past retention and leaves the rest alone', async () => {
    const expired = await deletedContact({ deletedDaysAgo: 31 });
    const recent = await deletedContact({ deletedDaysAgo: 3 });
    const live = await liveContact();

    await harness.queueSweep();
    await harness.drain();

    expect(await contactExists(expired)).toBe(false);
    expect(await contactExists(recent)).toBe(true);
    expect(await contactExists(live)).toBe(true);
  });

  it('leaves a record deleted exactly at the boundary for the next sweep', async () => {
    // 29 days: inside the window by a day. A test asserting "30" exactly would
    // be asserting the clock, not the rule.
    const borderline = await deletedContact({ deletedDaysAgo: 29 });

    await harness.queueSweep();
    await harness.drain();

    expect(await contactExists(borderline)).toBe(true);
  });

  it('writes an audit row for every purge, with no actor', async () => {
    const expired = await deletedContact({ deletedDaysAgo: 40 });

    await harness.queueSweep();
    await harness.drain();

    const rows = await rowsOf<{ action: string; actor_id: string | null }>(
      'select action, actor_id from audit_logs where record_id = $1',
      [expired],
    );
    const purge = rows.find((row) => row.action === 'purge');
    expect(purge).toBeDefined();
    // The system did it; saying so is the point of the row.
    expect(purge?.actor_id).toBeNull();
  });

  it('publishes a purged event for anything that lives outside this database', async () => {
    const expired = await deletedContact({ deletedDaysAgo: 40 });

    await harness.queueSweep();
    await harness.drain();

    const rows = await rowsOf<{ event_type: string }>(
      'select event_type from outbox_events where record_id = $1',
      [expired],
    );
    expect(rows.map((row) => row.event_type)).toContain('contact.purged.v1');
  });
});

describe('what soft delete left behind (ADR-0005)', () => {
  it('removes the links, tags, timeline and recently-viewed rows that pointed at it', async () => {
    const userId = await harness.user('Admin');
    const expired = await deletedContact({ deletedDaysAgo: 45 });

    const activityId = newId();
    const tagId = newId();
    await harness.pool.query(
      `insert into activities (id, tenant_id, type, subject, assigned_to)
       values ($1, $2, 'task', 'Call back', $3)`,
      [activityId, harness.tenantId, userId],
    );
    await harness.pool.query(
      `insert into activity_links (id, tenant_id, activity_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [newId(), harness.tenantId, activityId, expired],
    );
    await harness.pool.query(
      `insert into tags (id, tenant_id, name) values ($1, $2, $3)`,
      [tagId, harness.tenantId, `tag-${newId().slice(0, 8)}`],
    );
    await harness.pool.query(
      `insert into record_tags (id, tenant_id, tag_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [newId(), harness.tenantId, tagId, expired],
    );
    await harness.pool.query(
      `insert into timeline_events (id, tenant_id, object_type, record_id, event_type, summary)
       values ($1, $2, 'contact', $3, 'contact.created.v1', 'Contact created')`,
      [newId(), harness.tenantId, expired],
    );
    await harness.pool.query(
      `insert into record_views (id, tenant_id, user_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [newId(), harness.tenantId, userId, expired],
    );

    await harness.queueSweep();
    await harness.drain();

    for (const table of ['activity_links', 'record_tags', 'timeline_events', 'record_views']) {
      const rows = await harness.pool.query(
        `select 1 from ${table} where object_type = 'contact' and record_id = $1`,
        [expired],
      );
      expect(rows.rows, `${table} should have no rows pointing at a purged record`).toHaveLength(0);
    }

    // The activity itself survives: it was about the contact, it is not part of
    // it, and somebody may still want to know the call was made.
    expect(
      (await harness.pool.query('select 1 from activities where id = $1', [activityId])).rows,
    ).toHaveLength(1);
  });

  it('removes any search index rows that outlived the soft delete', async () => {
    const expired = await deletedContact({ deletedDaysAgo: 45 });
    await harness.pool.query(
      `insert into search_documents
         (id, tenant_id, object_type, record_id, field_key, value, weight, record_updated_at)
       values ($1, $2, 'contact', $3, 'last_name', 'Purgeable', 'A', now())`,
      [newId(), harness.tenantId, expired],
    );

    await harness.queueSweep();
    await harness.drain();

    const rows = await harness.pool.query('select 1 from search_documents where record_id = $1', [
      expired,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it('keeps the links of a record still in the Bin', async () => {
    const recent = await deletedContact({ deletedDaysAgo: 2 });
    await harness.pool.query(
      `insert into timeline_events (id, tenant_id, object_type, record_id, event_type, summary)
       values ($1, $2, 'contact', $3, 'contact.created.v1', 'Contact created')`,
      [newId(), harness.tenantId, recent],
    );

    await harness.queueSweep();
    await harness.drain();

    // The whole reason they are kept: the record can still come back, and it
    // should come back with its history attached.
    const rows = await harness.pool.query('select 1 from timeline_events where record_id = $1', [
      recent,
    ]);
    expect(rows.rows).toHaveLength(1);
  });
});

describe('idempotency and scheduling (ADR-0006, ADR-0025)', () => {
  it('a second sweep over the same tenant does nothing further and does not fail', async () => {
    const expired = await deletedContact({ deletedDaysAgo: 60 });

    await harness.queueSweep();
    await harness.drain();
    expect(await contactExists(expired)).toBe(false);

    await harness.queueSweep();
    const processed = await harness.drain();
    expect(processed).toBeGreaterThan(0);

    // Exactly one purge audit row, not two.
    const rows = await harness.pool.query(
      `select 1 from audit_logs where record_id = $1 and action = 'purge'`,
      [expired],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('arms exactly one pending sweep for the next run', async () => {
    await harness.queueSweep();
    await harness.drain();

    expect(await countPendingSweeps()).toBe(1);
  });

  it('never queues two pending sweeps for one tenant', async () => {
    // The partial unique index is what guarantees this, so queue several and
    // check the database refused the duplicates rather than trusting the code.
    await harness.queueSweep();
    await harness.queueSweep();
    await harness.queueSweep();

    expect(await countPendingSweeps()).toBe(1);
  });

  it('comes back promptly when a batch filled up, rather than tomorrow', async () => {
    const tenant = (await harness.otherTenant()).tenantId;
    // One more than a batch, so the sweep knows there is more to do. The batch
    // size is 200 (`PURGE_BATCH_SIZE`); this inserts just over it for one object.
    const values = Array.from({ length: 201 }, () => newId());
    await harness.pool.query(
      `insert into contacts (id, tenant_id, last_name, deleted_at)
       select unnest($1::uuid[]), $2, 'Bulk', now() - interval '40 days'`,
      [values, tenant],
    );

    await harness.queueSweep(tenant);
    await harness.drain();

    const next = await harness.pool.query(
      `select available_at from outbox_events
       where tenant_id = $1 and event_type = 'recycle_bin.sweep_due.v1' and status = 'pending'`,
      [tenant],
    );
    const dueAt = (next.rows as { available_at: Date }[])[0]?.available_at;
    expect(dueAt).toBeInstanceOf(Date);
    const dueInMinutes = ((dueAt as Date).getTime() - Date.now()) / 60_000;
    expect(dueInMinutes).toBeLessThan(60);

    // And the rest are gone on the next pass.
    await harness.pool.query(
      `update outbox_events set available_at = now()
       where tenant_id = $1 and event_type = 'recycle_bin.sweep_due.v1' and status = 'pending'`,
      [tenant],
    );
    await harness.drain();

    const remaining = await rowsOf<{ count: string }>(
      `select count(*)::text as count from contacts where tenant_id = $1 and deleted_at is not null`,
      [tenant],
    );
    expect(Number(remaining[0]!.count)).toBe(0);
  });
});

describe('the cleanup list stays complete (ADR-0005)', () => {
  it('names every table that points at a record by (object_type, record_id)', async () => {
    // A meta test, like the RLS suite's. ADR-0005 traded the foreign key on this
    // side for cheap new object types, and the price is that a job has to clean
    // up — which only works if the job knows about every such table. A new
    // polymorphic table added without a line in the handler fails here rather
    // than leaving orphans nobody notices for a year.
    const rows = await rowsOf<{ table_name: string }>(
      `select c.table_name
       from information_schema.columns c
       where c.table_schema = 'public'
         and c.column_name = 'record_id'
         and exists (
           select 1 from information_schema.columns o
           where o.table_schema = c.table_schema
             and o.table_name = c.table_name
             and o.column_name = 'object_type'
         )
       group by c.table_name`,
    );

    const polymorphic = rows.map((row) => row.table_name).sort();
    // `search_documents` is a projection rather than a reference and is cleared
    // by the same pass, deliberately outside the list (see the handler).
    const expected = [...POLYMORPHIC_REFERENCE_TABLE_LIST, 'search_documents'].sort();

    expect(
      polymorphic.filter((table) => !(expected as readonly string[]).includes(table)),
      'A table references records by (object_type, record_id) and the purge does not clean it up. ' +
        'Add it to POLYMORPHIC_REFERENCE_TABLE_LIST in recycle-bin.ts.',
    ).toEqual([]);
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it("one tenant's sweep does not touch another tenant's records", async () => {
    const neighbour = (await harness.otherTenant()).tenantId;
    const theirs = await deletedContact({ tenantId: neighbour, deletedDaysAgo: 90 });
    const mine = await deletedContact({ deletedDaysAgo: 90 });

    await harness.queueSweep();
    await harness.drain();

    expect(await contactExists(mine)).toBe(false);
    expect(await contactExists(theirs)).toBe(true);
  });
});
