import { newId } from '@crm/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant } from './client.js';
import {
  loadSampleData,
  removeSampleData,
  SampleDataAlreadyPresentError,
  SampleDataUnavailableError,
  type SampleCounts,
} from './onboarding/index.js';
import { provisionTenantDefaults } from './seed/index.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * Sample data: loading it, and — the part that can do harm — taking it away
 * (MVP_SPEC M2, ADR-0037).
 *
 * The acceptance criterion is "Remove sample data deletes only seeded records",
 * and the way that goes wrong is not a delete that fails. Nearly every
 * reference to these tables is `ON DELETE SET NULL` or `CASCADE`, so a missed
 * reference makes the delete *succeed* and quietly null a column or drop a link
 * on something a person made. So these tests do not stop at "the target
 * survived": each reference the removal has to respect gets its own case, and
 * each asserts that the **referrer's pointer is still there** afterwards.
 *
 * Loading runs as the application role and removal as the worker, exactly as in
 * production, because which role may do what is part of what is being proved.
 */

let db: TestDatabase;
let su: pg.Pool;

const LOADED: SampleCounts = { accounts: 3, contacts: 4, leads: 4, deals: 5, activities: 4 };
const NOTHING: SampleCounts = { accounts: 0, contacts: 0, leads: 0, deals: 0, activities: 0 };
const TOTAL = 3 + 4 + 4 + 5 + 4;

beforeAll(() => {
  const urls = inject('dbUrls');
  db = createTestDatabase(urls);
  su = new pg.Pool({ connectionString: urls.superuser, max: 4 });
});

afterAll(async () => {
  await Promise.all([db.close(), su.end()]);
});

interface Workspace {
  readonly tenantId: string;
  readonly userId: string;
  readonly pipelineId: string;
  readonly openStageId: string;
  readonly currency: string;
}

/** A company the way sign-up leaves it: roles, fields, a default pipeline, nothing else. */
async function workspace(currency = 'INR'): Promise<Workspace> {
  const tenantId = (await db.fixtures.createTenant({ name: `Sample ${newId().slice(-8)}` }))
    .tenantId;
  const provisioned = await withTenant(db.app.db, { tenantId, userId: null }, (tx) =>
    provisionTenantDefaults(tx, tenantId, null),
  );
  const userId = (await db.fixtures.createUser(tenantId, provisioned.roleIdsByName.get('Owner')!))
    .userId;
  const [pipeline] = await db.fixtures.pipelinesFor(tenantId);
  const openStage = pipeline!.stages.find((stage) => stage.stageType === 'open')!;
  return { tenantId, userId, pipelineId: pipeline!.id, openStageId: openStage.id, currency };
}

function load(w: Workspace): Promise<SampleCounts> {
  return withTenant(db.app.db, { tenantId: w.tenantId, userId: w.userId }, (tx) =>
    loadSampleData(tx, { tenantId: w.tenantId, actorId: w.userId, currency: w.currency }),
  );
}

/** As the worker does it: its own role, inside the tenant. */
function remove(w: Workspace) {
  return withTenant(db.worker.db, { tenantId: w.tenantId, userId: null }, (tx) =>
    removeSampleData(tx, { tenantId: w.tenantId, actorId: w.userId }),
  );
}

async function count(text: string, params: unknown[]): Promise<number> {
  const result = await su.query<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(result.rows[0]?.n ?? '0');
}

const rowsIn = (table: string, tenantId: string) =>
  count(`${table} where tenant_id = $1`, [tenantId]);

async function idOf(w: Workspace, table: string, column: string, value: string): Promise<string> {
  const result = await su.query<{ id: string }>(
    `select id::text from ${table} where tenant_id = $1 and ${column} = $2`,
    [w.tenantId, value],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no ${table}.${column} = ${value}`);
  return row.id;
}

const account = (w: Workspace, name: string) => idOf(w, 'accounts', 'name', `${name} (sample)`);
const contact = (w: Workspace, last: string) =>
  idOf(w, 'contacts', 'last_name', `${last} (sample)`);
const deal = (w: Workspace, name: string) => idOf(w, 'deals', 'name', `${name} (sample)`);
const task = (w: Workspace, subject: string) =>
  idOf(w, 'activities', 'subject', `${subject} (sample)`);

async function exists(table: string, id: string): Promise<boolean> {
  return (await count(`${table} where id = $1`, [id])) === 1;
}

async function column(table: string, id: string, name: string): Promise<string | null> {
  const result = await su.query<Record<string, string | null>>(
    `select ${name}::text as value from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.['value'] ?? null;
}

/** What an inline edit does to a record: nothing but the version moves on. */
async function edit(table: string, id: string): Promise<void> {
  await su.query(`update ${table} set version = version + 1, updated_at = now() where id = $1`, [
    id,
  ]);
}

const allIds = async (w: Workspace, table: string): Promise<string[]> =>
  (
    await su.query<{ id: string }>(`select id::text from ${table} where tenant_id = $1`, [
      w.tenantId,
    ])
  ).rows.map((row) => row.id);

// ===========================================================================
describe('loading sample data', () => {
  it('creates a small company, owned by whoever loaded it, in the company currency', async () => {
    const w = await workspace('INR');
    expect(await load(w)).toEqual(LOADED);

    expect(await rowsIn('accounts', w.tenantId)).toBe(3);
    expect(await rowsIn('contacts', w.tenantId)).toBe(4);
    expect(await rowsIn('leads', w.tenantId)).toBe(4);
    expect(await rowsIn('deals', w.tenantId)).toBe(5);
    expect(await rowsIn('activities', w.tenantId)).toBe(4);

    const owners = await su.query<{ n: string }>(
      `select count(*)::text as n from deals where tenant_id = $1 and owner_id = $2 and currency = 'INR'`,
      [w.tenantId, w.userId],
    );
    expect(Number(owners.rows[0]?.n)).toBe(5);
  });

  it('marks every record as sample in the one place it is always shown', async () => {
    const w = await workspace();
    await load(w);

    const unmarked = await su.query<{ n: string }>(
      `select (
         (select count(*) from accounts where tenant_id = $1 and name not like '%(sample)')
       + (select count(*) from contacts where tenant_id = $1 and last_name not like '%(sample)')
       + (select count(*) from leads    where tenant_id = $1 and last_name not like '%(sample)')
       + (select count(*) from deals    where tenant_id = $1 and name not like '%(sample)')
       + (select count(*) from activities where tenant_id = $1 and subject not like '%(sample)')
       )::text as n`,
      [w.tenantId],
    );
    expect(Number(unmarked.rows[0]?.n)).toBe(0);
  });

  it('registers exactly the records it created', async () => {
    const w = await workspace();
    await load(w);

    expect(await rowsIn('sample_records', w.tenantId)).toBe(TOTAL);
    const unregistered = await su.query<{ n: string }>(
      `select count(*)::text as n from deals d
       where d.tenant_id = $1
         and not exists (select 1 from sample_records s
                         where s.tenant_id = d.tenant_id and s.object_type = 'deal'
                           and s.record_id = d.id)`,
      [w.tenantId],
    );
    expect(Number(unregistered.rows[0]?.n)).toBe(0);
  });

  it('leaves the traces a real creation leaves, so it is searchable and on timelines', async () => {
    const w = await workspace();
    await load(w);

    const events = await db.fixtures.outboxEventTypes(w.tenantId);
    const tally = (type: string) => events.filter((event) => event === type).length;
    expect(tally('account.created.v1')).toBe(3);
    expect(tally('contact.created.v1')).toBe(4);
    expect(tally('lead.created.v1')).toBe(4);
    expect(tally('deal.created.v1')).toBe(5);
    expect(tally('activity.created.v1')).toBe(4);
    // One per link, written from the target's side (the timeline projector's contract).
    expect(tally('activity.linked.v1')).toBe(4);

    const created = await su.query<{ n: string }>(
      `select count(*)::text as n from audit_logs
       where tenant_id = $1 and action = 'create' and actor_id = $2`,
      [w.tenantId, w.userId],
    );
    expect(Number(created.rows[0]?.n)).toBe(TOTAL);
    expect(
      (await db.fixtures.auditEntries(w.tenantId, 'tenant')).map((entry) => entry.action),
    ).toContain('sample_data_loaded');
  });

  it('never notifies anybody about a task nobody wrote', async () => {
    const w = await workspace();
    await load(w);

    const events = await db.fixtures.outboxEventTypes(w.tenantId);
    expect(events).not.toContain('activity.assigned.v1');
    expect(events).not.toContain('activity.reminder_due.v1');
    expect(
      await count('activities where tenant_id = $1 and reminder_at is not null', [w.tenantId]),
    ).toBe(0);
  });

  it('gives the tasks real due dates, one of them already overdue', async () => {
    const w = await workspace();
    await load(w);
    const result = await su.query<{ overdue: string; upcoming: string }>(
      `select count(*) filter (where due_at < clock_timestamp())::text as overdue,
              count(*) filter (where due_at > clock_timestamp())::text as upcoming
       from activities where tenant_id = $1`,
      [w.tenantId],
    );
    expect(Number(result.rows[0]?.overdue)).toBe(1);
    expect(Number(result.rows[0]?.upcoming)).toBe(3);
  });

  it('puts every deal in a stage whose probability it carries', async () => {
    const w = await workspace();
    await load(w);
    const mismatched = await su.query<{ n: string }>(
      `select count(*)::text as n from deals d
       join pipeline_stages s on s.id = d.stage_id
       where d.tenant_id = $1 and d.probability <> s.probability`,
      [w.tenantId],
    );
    expect(Number(mismatched.rows[0]?.n)).toBe(0);
    // One is already won, so "deals won this month" has something to show.
    expect(await count(`deals where tenant_id = $1 and closed_at is not null`, [w.tenantId])).toBe(
      1,
    );
  });

  it('works when an administrator has renamed every stage: nothing is found by name', async () => {
    const w = await workspace();
    await su.query(
      `update pipeline_stages set name = 'Stage ' || position where pipeline_id = $1`,
      [w.pipelineId],
    );
    expect(await load(w)).toEqual(LOADED);
  });

  it('writes amounts in minor units for the currency, not a fixed two decimals', async () => {
    for (const [currency, expected] of [
      ['INR', '8500000'], // 85,000.00 — two decimals
      ['JPY', '85000'], // 85,000 — none
      ['KWD', '85000000'], // 85,000.000 — three
    ] as const) {
      const w = await workspace(currency);
      await load(w);
      const id = await deal(w, 'Showroom fit-out');
      expect(await column('deals', id, 'amount_minor'), currency).toBe(expected);
    }
  });

  it('refuses a second load rather than doubling the company', async () => {
    const w = await workspace();
    await load(w);

    await expect(load(w)).rejects.toBeInstanceOf(SampleDataAlreadyPresentError);

    expect(await rowsIn('accounts', w.tenantId)).toBe(3);
    expect(await rowsIn('sample_records', w.tenantId)).toBe(TOTAL);
  });

  it('lets exactly one of two simultaneous loads through', async () => {
    const w = await workspace();

    const outcomes = await Promise.allSettled([load(w), load(w)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(SampleDataAlreadyPresentError);
    expect(await rowsIn('accounts', w.tenantId)).toBe(3);
    expect(await rowsIn('sample_records', w.tenantId)).toBe(TOTAL);
  });

  it('is all or nothing: a failure after loading leaves no trace of it', async () => {
    const w = await workspace();

    await expect(
      withTenant(db.app.db, { tenantId: w.tenantId, userId: w.userId }, async (tx) => {
        await loadSampleData(tx, { tenantId: w.tenantId, actorId: w.userId, currency: 'INR' });
        throw new Error('the request failed afterwards');
      }),
    ).rejects.toThrow('failed afterwards');

    expect(await rowsIn('accounts', w.tenantId)).toBe(0);
    expect(await rowsIn('deals', w.tenantId)).toBe(0);
    expect(await rowsIn('sample_records', w.tenantId)).toBe(0);
    expect(await rowsIn('audit_logs', w.tenantId)).toBe(0);
  });

  it('says so when there is no pipeline to put deals in, and writes nothing', async () => {
    const tenantId = (await db.fixtures.createTenant({ name: 'No pipeline' })).tenantId;

    await expect(
      withTenant(db.app.db, { tenantId, userId: null }, (tx) =>
        loadSampleData(tx, { tenantId, actorId: newId(), currency: 'INR' }),
      ),
    ).rejects.toBeInstanceOf(SampleDataUnavailableError);

    expect(await rowsIn('accounts', tenantId)).toBe(0);
    expect(await rowsIn('sample_records', tenantId)).toBe(0);
  });

  it('touches nothing in another company', async () => {
    const a = await workspace();
    const b = await workspace();
    await load(b);

    await load(a);

    expect(await rowsIn('sample_records', a.tenantId)).toBe(TOTAL);
    expect(await rowsIn('sample_records', b.tenantId)).toBe(TOTAL);
    expect(await rowsIn('accounts', b.tenantId)).toBe(3);
  });
});

// ===========================================================================
describe('removing sample data', () => {
  it('removes every record nobody has touched, with everything that pointed at them', async () => {
    const w = await workspace();
    await load(w);

    const result = await remove(w);

    expect(result.removed).toEqual(LOADED);
    expect(result.kept).toEqual(NOTHING);
    for (const table of ['accounts', 'contacts', 'leads', 'deals', 'activities']) {
      expect(await rowsIn(table, w.tenantId), table).toBe(0);
    }
    expect(await rowsIn('sample_records', w.tenantId)).toBe(0);
    expect(await rowsIn('activity_links', w.tenantId)).toBe(0);
    expect(await rowsIn('deal_contacts', w.tenantId)).toBe(0);
  });

  it('removes only what was seeded: everything a person made is untouched', async () => {
    const w = await workspace();
    const mineAccount = await db.fixtures.createAccount(w.tenantId, { name: 'My own account' });
    const mineContact = await db.fixtures.createContact(w.tenantId, {
      lastName: 'Mine',
      accountId: mineAccount,
    });
    const mineLead = await db.fixtures.createLead(w.tenantId, { lastName: 'Mine' });
    const mineDeal = await db.fixtures.createDeal(w.tenantId, {
      pipelineId: w.pipelineId,
      stageId: w.openStageId,
      name: 'My own deal',
      accountId: mineAccount,
      primaryContactId: mineContact,
    });
    const mineTask = await db.fixtures.createActivity(w.tenantId, { subject: 'My own task' });
    await db.fixtures.linkActivity(w.tenantId, mineTask, 'deal', mineDeal);

    await load(w);
    await remove(w);

    expect(await rowsIn('accounts', w.tenantId)).toBe(1);
    expect(await rowsIn('contacts', w.tenantId)).toBe(1);
    expect(await rowsIn('leads', w.tenantId)).toBe(1);
    expect(await rowsIn('deals', w.tenantId)).toBe(1);
    expect(await rowsIn('activities', w.tenantId)).toBe(1);
    // …and what ties them together is intact.
    expect(await column('contacts', mineContact, 'account_id')).toBe(mineAccount);
    expect(await column('deals', mineDeal, 'account_id')).toBe(mineAccount);
    expect(await column('deals', mineDeal, 'primary_contact_id')).toBe(mineContact);
    expect(await count('activity_links where activity_id = $1', [mineTask])).toBe(1);
    expect(await exists('leads', mineLead)).toBe(true);
  });

  it('does nothing, safely, when there is nothing to remove or it was already removed', async () => {
    const w = await workspace();
    expect(await remove(w)).toEqual({ removed: NOTHING, kept: NOTHING });

    await load(w);
    await remove(w);
    expect(await remove(w)).toEqual({ removed: NOTHING, kept: NOTHING });
  });

  it('can be followed by loading again', async () => {
    const w = await workspace();
    await load(w);
    await remove(w);

    expect(await load(w)).toEqual(LOADED);
    expect(await rowsIn('sample_records', w.tenantId)).toBe(TOTAL);
  });

  // -------------------------------------------------------------------------
  describe('a record somebody edited is theirs now', () => {
    it('keeps it, and lets everything untouched go', async () => {
      const w = await workspace();
      await load(w);
      const edited = await contact(w, 'Gupta');
      await edit('contacts', edited);

      const result = await remove(w);

      expect(await exists('contacts', edited)).toBe(true);
      expect(result.kept.contacts).toBeGreaterThanOrEqual(1);
      expect(result.removed.leads).toBe(4);
      expect(result.removed.activities).toBe(4);
      // Released from the registry: it is the company's record, not sample data.
      expect(await count('sample_records where tenant_id = $1', [w.tenantId])).toBe(0);
    });

    it('keeps what the edited record points at, because deleting it would hollow it out', async () => {
      const w = await workspace();
      await load(w);
      const gupta = await contact(w, 'Gupta');
      const bluewave = await account(w, 'Bluewave Logistics');
      await edit('contacts', gupta);

      await remove(w);

      expect(await column('contacts', gupta, 'account_id')).toBe(bluewave);
      expect(await exists('accounts', bluewave)).toBe(true);
      // The other two accounts were nobody's business and went.
      expect(await rowsIn('accounts', w.tenantId)).toBe(1);
    });

    it('keeps a deal it edited together with its account, its contacts and its link rows', async () => {
      const w = await workspace();
      await load(w);
      const kept = await deal(w, 'Quarterly supply contract');
      const greenleaf = await account(w, 'Greenleaf Organics');
      const rohan = await contact(w, 'Kapoor');
      const meera = await contact(w, 'Iyer');
      await edit('deals', kept);

      await remove(w);

      expect(await exists('deals', kept)).toBe(true);
      expect(await column('deals', kept, 'account_id')).toBe(greenleaf);
      expect(await column('deals', kept, 'primary_contact_id')).toBe(rohan);
      expect(
        await count('deal_contacts where deal_id = $1 and contact_id = $2', [kept, rohan]),
      ).toBe(1);
      // Meera is on Greenleaf too, but the deal does not point at her.
      expect(await exists('contacts', meera)).toBe(false);
      expect(await rowsIn('deals', w.tenantId)).toBe(1);
    });

    // The sample data is redundant on purpose-by-accident: every deal's contact is on
    // the deal's own account, so keeping the contact keeps the account too, and a
    // missing deal -> account edge would go unnoticed. These three break that, so
    // each edge from a kept deal has to do its own work.
    it("keeps a kept deal's account even when none of its contacts lead there", async () => {
      const w = await workspace();
      await load(w);
      const kept = await deal(w, 'Showroom fit-out');
      const bluewave = await account(w, 'Bluewave Logistics');
      // Point the deal at an account none of its contacts belong to.
      await su.query('update deals set account_id = $2, version = version + 1 where id = $1', [
        kept,
        bluewave,
      ]);

      await remove(w);

      expect(await column('deals', kept, 'account_id')).toBe(bluewave);
      expect(await exists('accounts', bluewave)).toBe(true);
    });

    it("keeps a kept deal's primary contact even when it is not among the deal's contacts", async () => {
      const w = await workspace();
      await load(w);
      const kept = await deal(w, 'Showroom fit-out');
      const stranger = await contact(w, 'Gupta');
      await su.query(
        'update deals set primary_contact_id = $2, version = version + 1 where id = $1',
        [kept, stranger],
      );

      await remove(w);

      expect(await column('deals', kept, 'primary_contact_id')).toBe(stranger);
      expect(await exists('contacts', stranger)).toBe(true);
    });

    it('keeps every contact on a kept deal, not only its primary one', async () => {
      const w = await workspace();
      await load(w);
      const kept = await deal(w, 'Showroom fit-out');
      const extra = await contact(w, 'Iyer');
      await db.fixtures.linkDealContact(w.tenantId, kept, extra, 'Influencer');
      await edit('deals', kept);

      await remove(w);

      expect(
        await count('deal_contacts where deal_id = $1 and contact_id = $2', [kept, extra]),
      ).toBe(1);
      expect(await exists('contacts', extra)).toBe(true);
    });

    it('follows a chain: an edited child account keeps its parent', async () => {
      const w = await workspace();
      await load(w);
      const sunrise = await account(w, 'Sunrise Textiles');
      const bluewave = await account(w, 'Bluewave Logistics');
      await db.fixtures.setAccountParent(sunrise, bluewave);
      await edit('accounts', sunrise);

      await remove(w);

      expect(await column('accounts', sunrise, 'parent_account_id')).toBe(bluewave);
      expect(await exists('accounts', bluewave)).toBe(true);
      // Greenleaf is nobody's parent or child and nothing refers to it: it went.
      expect(await rowsIn('accounts', w.tenantId)).toBe(2);
    });

    it('follows a longer chain: an edited task keeps its deal, which keeps its account and contact', async () => {
      const w = await workspace();
      await load(w);
      const edited = await task(w, 'Send the supply contract draft');
      const supply = await deal(w, 'Quarterly supply contract');
      const greenleaf = await account(w, 'Greenleaf Organics');
      const rohan = await contact(w, 'Kapoor');
      await edit('activities', edited);

      await remove(w);

      expect(await exists('activities', edited)).toBe(true);
      expect(await count('activity_links where activity_id = $1', [edited])).toBe(1);
      expect(await exists('deals', supply)).toBe(true);
      expect(await column('deals', supply, 'account_id')).toBe(greenleaf);
      expect(await column('deals', supply, 'primary_contact_id')).toBe(rohan);
      expect(await rowsIn('activities', w.tenantId)).toBe(1);
    });

    it('keeps a lead converted onto a sample contact, and that contact with its account', async () => {
      const w = await workspace();
      await load(w);
      const lead = await idOf(w, 'leads', 'last_name', 'Kulkarni (sample)');
      const priya = await contact(w, 'Nair');
      const sunrise = await account(w, 'Sunrise Textiles');
      await su.query(
        `update leads set status = 'converted', converted_at = now(), converted_contact_id = $2,
                version = version + 1 where id = $1`,
        [lead, priya],
      );

      await remove(w);

      expect(await column('leads', lead, 'converted_contact_id')).toBe(priya);
      expect(await exists('contacts', priya)).toBe(true);
      expect(await column('contacts', priya, 'account_id')).toBe(sunrise);
    });
  });

  // -------------------------------------------------------------------------
  describe('a record somebody built on is theirs now', () => {
    /**
     * Each case makes one non-sample thing that refers to one sample record, runs
     * the removal, and then asks two questions: did the target survive, and is the
     * thing that refers to it **still pointing at it**. The second is the one a
     * missed reference fails, silently, because the foreign keys null or cascade.
     */
    const cases: {
      name: string;
      build: (
        w: Workspace,
      ) => Promise<{ target: [string, string]; stillPointing: () => Promise<boolean> }>;
    }[] = [
      {
        name: 'a deal somebody created, in a sample account',
        build: async (w) => {
          const target = await account(w, 'Greenleaf Organics');
          const mine = await db.fixtures.createDeal(w.tenantId, {
            pipelineId: w.pipelineId,
            stageId: w.openStageId,
            name: 'Mine',
            accountId: target,
          });
          return {
            target: ['accounts', target],
            stillPointing: async () => (await column('deals', mine, 'account_id')) === target,
          };
        },
      },
      {
        name: 'a deal somebody created, with a sample contact as its primary contact',
        build: async (w) => {
          const target = await contact(w, 'Kapoor');
          const mine = await db.fixtures.createDeal(w.tenantId, {
            pipelineId: w.pipelineId,
            stageId: w.openStageId,
            name: 'Mine',
            primaryContactId: target,
          });
          return {
            target: ['contacts', target],
            stillPointing: async () =>
              (await column('deals', mine, 'primary_contact_id')) === target,
          };
        },
      },
      {
        name: 'a deal somebody created, with a sample contact attached through deal_contacts',
        build: async (w) => {
          const target = await contact(w, 'Iyer');
          const mine = await db.fixtures.createDeal(w.tenantId, {
            pipelineId: w.pipelineId,
            stageId: w.openStageId,
            name: 'Mine',
          });
          await db.fixtures.linkDealContact(w.tenantId, mine, target, 'Buyer');
          return {
            target: ['contacts', target],
            stillPointing: async () =>
              (await count('deal_contacts where deal_id = $1 and contact_id = $2', [
                mine,
                target,
              ])) === 1,
          };
        },
      },
      {
        name: 'a contact somebody created, at a sample account',
        build: async (w) => {
          const target = await account(w, 'Bluewave Logistics');
          const mine = await db.fixtures.createContact(w.tenantId, {
            lastName: 'Mine',
            accountId: target,
          });
          return {
            target: ['accounts', target],
            stillPointing: async () => (await column('contacts', mine, 'account_id')) === target,
          };
        },
      },
      {
        name: 'an account somebody created, as a child of a sample account',
        build: async (w) => {
          const target = await account(w, 'Sunrise Textiles');
          const mine = await db.fixtures.createAccount(w.tenantId, { name: 'Mine' });
          await db.fixtures.setAccountParent(mine, target);
          return {
            target: ['accounts', target],
            stillPointing: async () =>
              (await column('accounts', mine, 'parent_account_id')) === target,
          };
        },
      },
      {
        name: 'a lead somebody converted into a sample contact',
        build: async (w) => {
          const target = await contact(w, 'Gupta');
          const mine = await db.fixtures.createLead(w.tenantId, {
            lastName: 'Mine',
            status: 'converted',
            convertedAt: new Date(),
            convertedContactId: target,
          });
          return {
            target: ['contacts', target],
            stillPointing: async () =>
              (await column('leads', mine, 'converted_contact_id')) === target,
          };
        },
      },
      {
        name: 'a lead somebody converted into a sample account',
        build: async (w) => {
          const target = await account(w, 'Sunrise Textiles');
          const mine = await db.fixtures.createLead(w.tenantId, {
            lastName: 'Mine',
            status: 'converted',
            convertedAt: new Date(),
            convertedAccountId: target,
          });
          return {
            target: ['accounts', target],
            stillPointing: async () =>
              (await column('leads', mine, 'converted_account_id')) === target,
          };
        },
      },
      {
        name: 'a lead somebody converted into a sample deal',
        build: async (w) => {
          const target = await deal(w, 'Showroom fit-out');
          const mine = await db.fixtures.createLead(w.tenantId, {
            lastName: 'Mine',
            status: 'converted',
            convertedAt: new Date(),
            convertedDealId: target,
          });
          return {
            target: ['deals', target],
            stillPointing: async () =>
              (await column('leads', mine, 'converted_deal_id')) === target,
          };
        },
      },
      {
        name: 'a task somebody wrote about a sample deal',
        build: async (w) => {
          const target = await deal(w, 'Warehouse automation pilot');
          const mine = await db.fixtures.createActivity(w.tenantId, { subject: 'Mine' });
          await db.fixtures.linkActivity(w.tenantId, mine, 'deal', target);
          return {
            target: ['deals', target],
            stillPointing: async () =>
              (await count('activity_links where activity_id = $1 and record_id = $2', [
                mine,
                target,
              ])) === 1,
          };
        },
      },
      {
        name: 'a tag somebody put on a sample account',
        build: async (w) => {
          const target = await account(w, 'Greenleaf Organics');
          const tagId = newId();
          await su.query(`insert into tags (id, tenant_id, name) values ($1, $2, 'VIP')`, [
            tagId,
            w.tenantId,
          ]);
          const link = newId();
          await su.query(
            `insert into record_tags (id, tenant_id, tag_id, object_type, record_id)
             values ($1, $2, $3, 'account', $4)`,
            [link, w.tenantId, tagId, target],
          );
          return {
            target: ['accounts', target],
            stillPointing: async () => (await count('record_tags where id = $1', [link])) === 1,
          };
        },
      },
      {
        name: 'a file somebody attached to a sample contact',
        build: async (w) => {
          const target = await contact(w, 'Nair');
          const file = newId();
          await su.query(
            `insert into attachments (id, tenant_id, object_type, record_id, file_key, file_name, mime, size_bytes, status)
             values ($1, $2, 'contact', $3, $4, 'quote.pdf', 'application/pdf', 100, 'ready')`,
            [file, w.tenantId, target, `tenants/${w.tenantId}/attachments/${file}`],
          );
          return {
            target: ['contacts', target],
            stillPointing: async () => (await count('attachments where id = $1', [file])) === 1,
          };
        },
      },
    ];

    it.each(cases)('keeps the target of $name, and the reference to it', async ({ build }) => {
      const w = await workspace();
      await load(w);
      const { target, stillPointing } = await build(w);

      await remove(w);

      expect(await exists(target[0], target[1]), 'the sample record it refers to was deleted').toBe(
        true,
      );
      expect(await stillPointing(), 'the record somebody made lost its reference').toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  it('leaves a sample record somebody already deleted to the Recycle Bin, and what it points at', async () => {
    const w = await workspace();
    await load(w);
    const binned = await deal(w, 'Quarterly supply contract');
    const greenleaf = await account(w, 'Greenleaf Organics');
    await su.query(`update deals set deleted_at = now(), version = version + 1 where id = $1`, [
      binned,
    ]);

    await remove(w);

    // Still in the Bin, deleted-at intact, and restorable with its account.
    expect(await column('deals', binned, 'deleted_at')).not.toBeNull();
    expect(await column('deals', binned, 'account_id')).toBe(greenleaf);
    expect(await exists('accounts', greenleaf)).toBe(true);
    // It is no longer sample data.
    expect(await count('sample_records where record_id = $1', [binned])).toBe(0);
  });

  it('is isolated: removing one company never touches another', async () => {
    const a = await workspace();
    const b = await workspace();
    await load(a);
    await load(b);

    await remove(a);

    expect(await rowsIn('accounts', a.tenantId)).toBe(0);
    expect(await rowsIn('accounts', b.tenantId)).toBe(3);
    expect(await rowsIn('deals', b.tenantId)).toBe(5);
    expect(await rowsIn('sample_records', b.tenantId)).toBe(TOTAL);
  });

  it('records what it did, and tells the search index and attachment cleanup about each record', async () => {
    const w = await workspace();
    await load(w);
    await remove(w);

    const purges = await su.query<{ n: string }>(
      `select count(*)::text as n from audit_logs
       where tenant_id = $1 and action = 'purge' and actor_id = $2`,
      [w.tenantId, w.userId],
    );
    expect(Number(purges.rows[0]?.n)).toBe(TOTAL);

    const summary = await su.query<{
      changes: { removed: { new: SampleCounts }; kept: { new: SampleCounts } };
    }>(
      `select changes from audit_logs
       where tenant_id = $1 and action = 'sample_data_removed'`,
      [w.tenantId],
    );
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.changes.removed.new).toEqual(LOADED);
    expect(summary.rows[0]?.changes.kept.new).toEqual(NOTHING);

    const events = await db.fixtures.outboxEventTypes(w.tenantId);
    for (const type of ['account', 'contact', 'lead', 'deal', 'activity']) {
      expect(events, type).toContain(`${type}.purged.v1`);
    }
  });

  it('cannot be done by the application role: it may not write the projections it must clear', async () => {
    const w = await workspace();
    await load(w);

    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: w.tenantId, userId: w.userId }, (tx) =>
        removeSampleData(tx, { tenantId: w.tenantId, actorId: w.userId }),
      ),
    );

    // Search and timeline are the worker's to write; this is why removal is a job.
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    // And the attempt changed nothing.
    expect(await rowsIn('accounts', w.tenantId)).toBe(3);
    expect(await rowsIn('sample_records', w.tenantId)).toBe(TOTAL);
    expect(await allIds(w, 'deals')).toHaveLength(5);
  });
});
