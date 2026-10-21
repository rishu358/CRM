import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Company setup and sample data through the public API (MVP_SPEC M2, ADR-0037).
 *
 * The security properties are in `onboarding.security.spec.ts`; this is what the
 * feature does when everything is permitted: edit the profile, derive the
 * checklist from what exists, load sample data that behaves like real data, and
 * ask for it to be removed.
 */
let harness: ApiHarness;
let su: pg.Pool;

interface Person {
  userId: string;
  token: string;
}

interface Workspace {
  tenantId: string;
  admin: Person;
  rep: Person;
  roles: ReadonlyMap<string, string>;
}

interface Status {
  setupCompleted: boolean;
  checklist: { key: string; done: boolean }[];
  sampleData: {
    present: boolean;
    removing: boolean;
    counts: {
      accounts: number;
      contacts: number;
      leads: number;
      deals: number;
      activities: number;
    };
  };
}

async function workspace(
  name = `Setup ${Math.random().toString(36).slice(2, 8)}`,
): Promise<Workspace> {
  const tenantId = (await harness.fixtures.createTenant({ name })).tenantId;
  const roles = await harness.provision(tenantId);
  const make = async (role: string): Promise<Person> => {
    const created = await harness.fixtures.createUser(tenantId, roles.get(role)!);
    return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
  };
  return { tenantId, admin: await make('Admin'), rep: await make('Sales Rep'), roles };
}

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    token,
    ...(body === undefined ? {} : { body }),
  });

const status = async (w: Workspace): Promise<Status> =>
  dataOf<Status>(await call(w.admin.token, 'GET', '/onboarding'));

async function count(text: string, params: unknown[]): Promise<number> {
  const result = await su.query<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  su = new pg.Pool({ connectionString: urls.superuser, max: 2 });
});

afterAll(async () => {
  await Promise.all([harness.close(), su.end()]);
});

// ===========================================================================
describe('the company profile', () => {
  it('reads what sign-up left, with sensible defaults', async () => {
    const w = await workspace('Acme Jewellers');
    const profile = dataOf<Record<string, unknown>>(await call(w.admin.token, 'GET', '/tenant'));

    expect(profile).toEqual({
      name: 'Acme Jewellers',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      industry: null,
    });
  });

  it('edits each field, and returns the company as it now is', async () => {
    const w = await workspace();

    const updated = dataOf<Record<string, unknown>>(
      await call(w.admin.token, 'PATCH', '/tenant', {
        name: 'Gold & Co',
        defaultCurrency: 'USD',
        timezone: 'Asia/Dubai',
        industry: 'retail',
      }),
    );

    expect(updated).toMatchObject({
      name: 'Gold & Co',
      defaultCurrency: 'USD',
      timezone: 'Asia/Dubai',
      industry: 'retail',
    });
    expect(dataOf<Record<string, unknown>>(await call(w.admin.token, 'GET', '/tenant'))).toEqual(
      updated,
    );
  });

  it('can change one thing and leave the rest, and can clear the industry', async () => {
    const w = await workspace('Keep me');
    await call(w.admin.token, 'PATCH', '/tenant', { industry: 'retail' });

    const renamed = dataOf<Record<string, unknown>>(
      await call(w.admin.token, 'PATCH', '/tenant', { name: 'Renamed' }),
    );
    expect(renamed).toMatchObject({ name: 'Renamed', industry: 'retail', defaultCurrency: 'INR' });

    const cleared = dataOf<Record<string, unknown>>(
      await call(w.admin.token, 'PATCH', '/tenant', { industry: null }),
    );
    expect(cleared['industry']).toBeNull();
  });

  it('audits exactly what changed, with old and new, and announces it', async () => {
    const w = await workspace('Before');

    await call(w.admin.token, 'PATCH', '/tenant', { name: 'After', defaultCurrency: 'EUR' });

    const rows = await su.query<{
      changes: Record<string, { old: unknown; new: unknown }>;
      actor_id: string;
    }>(
      `select changes, actor_id::text from audit_logs
       where tenant_id = $1 and object_type = 'tenant' and action = 'update'`,
      [w.tenantId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.actor_id).toBe(w.admin.userId);
    expect(rows.rows[0]?.changes).toEqual({
      name: { old: 'Before', new: 'After' },
      defaultCurrency: { old: 'INR', new: 'EUR' },
    });
    expect(await harness.fixtures.outboxEventTypes(w.tenantId)).toContain('tenant.updated.v1');
  });

  it('records nothing when a save changes nothing', async () => {
    const w = await workspace('Same');

    await call(w.admin.token, 'PATCH', '/tenant', { name: 'Same', defaultCurrency: 'INR' });

    expect(
      await count(`audit_logs where tenant_id = $1 and object_type = 'tenant'`, [w.tenantId]),
    ).toBe(0);
    expect(await harness.fixtures.outboxEventTypes(w.tenantId)).not.toContain('tenant.updated.v1');
  });

  it.each([
    ['a currency that does not exist', { defaultCurrency: 'XYZ' }],
    ['a currency in lower case', { defaultCurrency: 'usd' }],
    ['a time zone that does not exist', { timezone: 'Mars/Phobos' }],
    ['an industry that is not offered', { industry: 'unicorn farming' }],
    ['an empty name', { name: '   ' }],
    ['a name that is far too long', { name: 'x'.repeat(121) }],
    ['nothing at all', {}],
  ])('refuses %s with a 422, and changes nothing', async (_what, body) => {
    const w = await workspace('Untouched');

    const response = await call(w.admin.token, 'PATCH', '/tenant', body);

    expect(response.status).toBe(422);
    expect(dataOf<{ name: string }>(await call(w.admin.token, 'GET', '/tenant')).name).toBe(
      'Untouched',
    );
  });
});

// ===========================================================================
describe('setup state and the checklist', () => {
  it('starts not completed, with nothing done and no sample data', async () => {
    // One person only: with two, "invite your team" is already true, correctly.
    const tenantId = (await harness.fixtures.createTenant({ name: 'Just me' })).tenantId;
    const roles = await harness.provision(tenantId);
    const created = await harness.fixtures.createUser(tenantId, roles.get('Owner')!);
    const w: Workspace = {
      tenantId,
      admin: { userId: created.userId, token: await harness.signIn(created.userId, tenantId) },
      rep: { userId: created.userId, token: '' },
      roles,
    };

    const state = await status(w);

    expect(state.setupCompleted).toBe(false);
    expect(state.checklist).toEqual([
      { key: 'invite_team', done: false },
      { key: 'import_contacts', done: false },
      { key: 'add_first_deal', done: false },
    ]);
    expect(state.sampleData).toEqual({
      present: false,
      removing: false,
      counts: { accounts: 0, contacts: 0, leads: 0, deals: 0, activities: 0 },
    });
  });

  it('is completed once, and completing again changes nothing and records nothing more', async () => {
    const w = await workspace();

    const first = dataOf<Status>(await call(w.admin.token, 'POST', '/onboarding/complete'));
    const second = dataOf<Status>(await call(w.admin.token, 'POST', '/onboarding/complete'));

    expect(first.setupCompleted).toBe(true);
    expect(second.setupCompleted).toBe(true);
    expect(
      await count(`audit_logs where tenant_id = $1 and object_type = 'tenant'`, [w.tenantId]),
    ).toBe(1);
    expect(
      (await harness.fixtures.outboxEventTypes(w.tenantId)).filter(
        (type) => type === 'tenant.setup_completed.v1',
      ),
    ).toHaveLength(1);
  });

  it('ticks "invite your team" when somebody is invited', async () => {
    const w = await workspace();
    const response = await call(w.admin.token, 'POST', '/invitations', {
      email: `new-${Math.random().toString(36).slice(2, 8)}@example.com`,
      roleId: w.roles.get('Sales Rep')!,
    });
    expect(response.status).toBe(201);

    const item = (await status(w)).checklist.find((entry) => entry.key === 'invite_team');
    expect(item?.done).toBe(true);
  });

  it('ticks "invite your team" when a second person is simply in the workspace', async () => {
    // `workspace()` already created two people, so the derived answer is yes
    // without an invitation row: the checklist asks what exists, not what was clicked.
    const w = await workspace();
    expect((await status(w)).checklist.find((entry) => entry.key === 'invite_team')?.done).toBe(
      true,
    );
  });

  it('ticks "import your contacts" only for an import that finished', async () => {
    const w = await workspace();
    // A job in the state the constraints allow: a finished one has said how to
    // treat duplicates and has counts that add up.
    const insert = (state: string) =>
      su.query(
        `insert into import_jobs
           (id, tenant_id, object_type, status, file_name, claimed_format, storage_key,
            mapping, duplicate_mode, total_rows, processed_rows, created_count, created_by)
         values (gen_random_uuid(), $1, 'contact', $2, 'people.csv', 'csv', $3,
                 '[]'::jsonb, 'create', 1, 1, 1, $4)`,
        [w.tenantId, state, `tenants/${w.tenantId}/imports/${Math.random()}`, w.admin.userId],
      );

    await insert('failed');
    expect((await status(w)).checklist.find((entry) => entry.key === 'import_contacts')?.done).toBe(
      false,
    );

    await insert('completed');
    expect((await status(w)).checklist.find((entry) => entry.key === 'import_contacts')?.done).toBe(
      true,
    );
  });

  it('ticks "add your first deal" for a deal somebody made, and not for a deleted one', async () => {
    const w = await workspace();
    const [pipeline] = await harness.fixtures.pipelinesFor(w.tenantId);
    const stageId = pipeline!.stages.find((stage) => stage.stageType === 'open')!.id;
    const done = async () =>
      (await status(w)).checklist.find((entry) => entry.key === 'add_first_deal')?.done;

    expect(await done()).toBe(false);
    const dealId = await harness.fixtures.createDeal(w.tenantId, {
      pipelineId: pipeline!.id,
      stageId,
      name: 'Mine',
    });
    expect(await done()).toBe(true);

    await su.query(`update deals set deleted_at = now() where id = $1`, [dealId]);
    expect(await done()).toBe(false);
  });
});

// ===========================================================================
describe('sample data', () => {
  it('is loaded as real records, in the company currency, with an honest count', async () => {
    const w = await workspace();
    await call(w.admin.token, 'PATCH', '/tenant', { defaultCurrency: 'JPY' });

    const response = await call(w.admin.token, 'POST', '/onboarding/sample-data');

    expect(response.status).toBe(201);
    expect(dataOf<{ created: Record<string, number> }>(response).created).toEqual({
      accounts: 3,
      contacts: 4,
      leads: 4,
      deals: 5,
      activities: 4,
    });
    // Yen has no minor unit, so ¥85,000 is stored as 85000, not 8500000.
    const amount = await su.query<{ amount_minor: string; currency: string }>(
      `select amount_minor::text, currency from deals where tenant_id = $1 and name like 'Showroom%'`,
      [w.tenantId],
    );
    expect(amount.rows[0]).toEqual({ amount_minor: '85000', currency: 'JPY' });

    const state = await status(w);
    expect(state.sampleData.present).toBe(true);
    expect(state.sampleData.counts).toEqual({
      accounts: 3,
      contacts: 4,
      leads: 4,
      deals: 5,
      activities: 4,
    });
  });

  it('shows up in the ordinary lists, marked, and is scoped like any other record', async () => {
    const w = await workspace();
    await call(w.admin.token, 'POST', '/onboarding/sample-data');

    const deals = dataOf<{ name: string }[]>(await call(w.admin.token, 'GET', '/deals?limit=100'));
    const contacts = dataOf<{ lastName: string }[]>(
      await call(w.admin.token, 'GET', '/contacts?limit=100'),
    );
    expect(deals.filter((deal) => deal.name.endsWith('(sample)'))).toHaveLength(5);
    expect(contacts.filter((contact) => contact.lastName.endsWith('(sample)'))).toHaveLength(4);

    // They are the administrator's, so a rep with own-scope sees none of them.
    const repDeals = dataOf<{ name: string }[]>(await call(w.rep.token, 'GET', '/deals?limit=100'));
    expect(repDeals).toHaveLength(0);
  });

  it('is refused a second time, and nothing is doubled', async () => {
    const w = await workspace();
    await call(w.admin.token, 'POST', '/onboarding/sample-data');

    const again = await call(w.admin.token, 'POST', '/onboarding/sample-data');

    expect(again.status).toBe(409);
    expect((await status(w)).sampleData.counts.accounts).toBe(3);
  });

  it('does not count as having added a first deal, until a real one exists', async () => {
    const w = await workspace();
    await call(w.admin.token, 'POST', '/onboarding/sample-data');
    const done = async () =>
      (await status(w)).checklist.find((entry) => entry.key === 'add_first_deal')?.done;

    // Five deals exist, none of them the company's own.
    expect(await done()).toBe(false);

    const [pipeline] = await harness.fixtures.pipelinesFor(w.tenantId);
    await harness.fixtures.createDeal(w.tenantId, {
      pipelineId: pipeline!.id,
      stageId: pipeline!.stages.find((stage) => stage.stageType === 'open')!.id,
      name: 'A real one',
    });
    expect(await done()).toBe(true);
  });

  it('can be asked to go: accepted, shown as removing, and not asked twice', async () => {
    const w = await workspace();
    await call(w.admin.token, 'POST', '/onboarding/sample-data');

    const first = await call(w.admin.token, 'DELETE', '/onboarding/sample-data');
    const second = await call(w.admin.token, 'DELETE', '/onboarding/sample-data');

    expect(first.status).toBe(202);
    expect(dataOf<{ status: string }>(first).status).toBe('removing');
    expect(second.status).toBe(202);
    // One job, however many times the button was pressed.
    expect(
      await count(
        `outbox_events where tenant_id = $1 and event_type = 'sample_data.removal_requested.v1'`,
        [w.tenantId],
      ),
    ).toBe(1);
    expect((await status(w)).sampleData.removing).toBe(true);
    // Not removed by the request itself: that is the worker's job.
    expect(await count('accounts where tenant_id = $1', [w.tenantId])).toBe(3);
  });

  it('says so when there is nothing to remove', async () => {
    const w = await workspace();

    const response = await call(w.admin.token, 'DELETE', '/onboarding/sample-data');

    expect(response.status).toBe(409);
  });

  it('can be added again once it has gone', async () => {
    const w = await workspace();
    await call(w.admin.token, 'POST', '/onboarding/sample-data');
    // As the worker would leave things after a removal.
    await su.query(`delete from sample_records where tenant_id = $1`, [w.tenantId]);
    await su.query(`delete from deal_contacts where tenant_id = $1`, [w.tenantId]);
    await su.query(`delete from activity_links where tenant_id = $1`, [w.tenantId]);
    for (const table of ['activities', 'deals', 'leads', 'contacts', 'accounts']) {
      await su.query(`delete from ${table} where tenant_id = $1`, [w.tenantId]);
    }

    const again = await call(w.admin.token, 'POST', '/onboarding/sample-data');

    expect(again.status).toBe(201);
  });
});

// ===========================================================================
describe('the first-run flow, as the setup screen performs it', () => {
  it('saves the details, loads sample data and finishes — in that order, each step visible', async () => {
    const w = await workspace('New Co');

    const profile = await call(w.admin.token, 'PATCH', '/tenant', {
      name: 'New Co Pvt Ltd',
      defaultCurrency: 'AED',
      timezone: 'Asia/Dubai',
      industry: 'services',
    });
    expect(profile.status).toBe(200);
    expect((await call(w.admin.token, 'POST', '/onboarding/sample-data')).status).toBe(201);
    expect((await call(w.admin.token, 'POST', '/onboarding/complete')).status).toBe(200);

    const state = await status(w);
    expect(state.setupCompleted).toBe(true);
    expect(state.sampleData.present).toBe(true);
    expect(
      dataOf<{ name: string; defaultCurrency: string }>(
        await call(w.admin.token, 'GET', '/tenant'),
      ),
    ).toMatchObject({
      name: 'New Co Pvt Ltd',
      defaultCurrency: 'AED',
    });
  });

  it('can be skipped: completing without saving anything is a valid way through', async () => {
    const w = await workspace('Skipper');

    const done = dataOf<Status>(await call(w.admin.token, 'POST', '/onboarding/complete'));

    expect(done.setupCompleted).toBe(true);
    expect(done.sampleData.present).toBe(false);
    expect(dataOf<{ name: string }>(await call(w.admin.token, 'GET', '/tenant')).name).toBe(
      'Skipper',
    );
  });
});
