import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10), for company
 * setup and sample data (MVP_SPEC M2, ADR-0037):
 *
 *   (a) tenant A cannot read, change or remove tenant B's company, checklist or
 *       sample data — and no request can name a tenant, a plan or a status
 *   (b) a role without the grants cannot use any of it, and a role that holds
 *       only *some* of what loading needs cannot load a partial company
 *   (c) hidden fields: there are none to hide here, and the one place a hidden
 *       value could leak — what the checklist and the counts reveal — is stated
 *       and tested below
 *   (d) unauthenticated requests get 401
 *
 * Through the real HTTP stack: the guards, pipes, filter and database roles are
 * all part of what is being asserted. Removal is accepted here and performed by
 * the worker, so what is checked is the request side; the work itself is proved
 * against the real relay in the worker's suite.
 */
let harness: ApiHarness;
let su: pg.Pool;

interface Person {
  userId: string;
  token: string;
}

let tenantA: string;
let tenantB: string;
let adminA: Person;
let ownerA: Person;
let repA: Person;
let managerA: Person;
let adminB: Person;
let rolesA: ReadonlyMap<string, string>;

async function person(tenantId: string, roleId: string, name = 'Test User'): Promise<Person> {
  const created = await harness.fixtures.createUser(tenantId, roleId, { name });
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

const call = (
  token: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    ...(token === undefined ? {} : { token }),
    ...(body === undefined ? {} : { body }),
  });

async function scalar(text: string, params: unknown[]): Promise<string> {
  const result = await su.query<{ v: string }>(text, params);
  return result.rows[0]?.v ?? '';
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  su = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  rolesA = await harness.provision(tenantA);
  ownerA = await person(tenantA, rolesA.get('Owner')!, 'Olga Owner');
  adminA = await person(tenantA, rolesA.get('Admin')!, 'Anita Admin');
  managerA = await person(tenantA, rolesA.get('Manager')!, 'Manish Manager');
  repA = await person(tenantA, rolesA.get('Sales Rep')!, 'Priya Rep');

  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const rolesB = await harness.provision(tenantB);
  adminB = await person(tenantB, rolesB.get('Admin')!, 'Bhavin Admin');
});

afterAll(async () => {
  await Promise.all([harness.close(), su.end()]);
});

const ROUTES: readonly {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
}[] = [
  { method: 'GET', url: '/tenant' },
  { method: 'PATCH', url: '/tenant', body: { name: 'Anything' } },
  { method: 'GET', url: '/onboarding' },
  { method: 'POST', url: '/onboarding/complete' },
  { method: 'POST', url: '/onboarding/sample-data' },
  { method: 'DELETE', url: '/onboarding/sample-data' },
];

// ===========================================================================
describe('(d) unauthenticated requests', () => {
  it.each(ROUTES)(
    'get 401 on $method $url, and the body says nothing about the company',
    async (route) => {
      const response = await call(undefined, route.method, route.url, route.body);

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/Acme|Rival|currency|timezone|industry/i);
    },
  );
});

// ===========================================================================
describe('(a) tenant isolation', () => {
  it("an administrator edits their own company and never another's", async () => {
    const before = await scalar(`select name as v from tenants where id = $1`, [tenantB]);

    const response = await call(adminA.token, 'PATCH', '/tenant', {
      name: 'Acme Jewellers Pvt Ltd',
    });

    expect(response.status).toBe(200);
    expect(await scalar(`select name as v from tenants where id = $1`, [tenantA])).toBe(
      'Acme Jewellers Pvt Ltd',
    );
    expect(await scalar(`select name as v from tenants where id = $1`, [tenantB])).toBe(before);
  });

  it.each([
    ['tenantId', 'a tenant id'],
    ['tenant_id', 'a tenant id in database spelling'],
    ['id', 'an id'],
    ['plan', 'a plan'],
    ['status', 'a status'],
    ['slug', 'a slug'],
    ['region', 'a region'],
    ['settings', 'a settings blob'],
    ['setupCompletedAt', 'a completion time'],
  ])('refuses a body that tries to set %s (%s), and changes nothing', async (key) => {
    const before = await su.query(
      `select plan, status, slug, region, settings from tenants where id = $1`,
      [tenantA],
    );

    const response = await call(adminA.token, 'PATCH', '/tenant', {
      name: 'Still Acme',
      [key]: key === 'settings' ? { x: 1 } : 'enterprise',
    });

    expect(response.status).toBe(422);
    const after = await su.query(
      `select plan, status, slug, region, settings from tenants where id = $1`,
      [tenantA],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('reads only its own company', async () => {
    const mine = dataOf<{ name: string }>(await call(adminA.token, 'GET', '/tenant'));
    const theirs = dataOf<{ name: string }>(await call(adminB.token, 'GET', '/tenant'));

    expect(mine.name).toContain('Acme');
    expect(theirs.name).toBe('Rival Traders');
  });

  it("does not let B's deals, imports or invitations tick A's checklist", async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Checklist A' })).tenantId;
    const roles = await harness.provision(tenant);
    const admin = await person(tenant, roles.get('Admin')!);
    const other = (await harness.fixtures.createTenant({ name: 'Checklist B' })).tenantId;
    await harness.provision(other);
    const [pipeline] = await harness.fixtures.pipelinesFor(other);
    await harness.fixtures.createDeal(other, {
      pipelineId: pipeline!.id,
      stageId: pipeline!.stages.find((stage) => stage.stageType === 'open')!.id,
      name: 'Rival deal',
    });
    await su.query(
      `insert into invitations (id, tenant_id, email, role_id, token_hash, expires_at)
       values (gen_random_uuid(), $1, 'x@rival.example', $2, 'h', now() + interval '1 day')`,
      [
        other,
        (
          await su.query<{ id: string }>(`select id from roles where tenant_id = $1 limit 1`, [
            other,
          ])
        ).rows[0]!.id,
      ],
    );

    const status = dataOf<{ checklist: { key: string; done: boolean }[] }>(
      await call(admin.token, 'GET', '/onboarding'),
    );

    expect(status.checklist.every((item) => !item.done)).toBe(true);
  });

  it("loads sample data into one company only, and can neither see nor remove another's", async () => {
    const loadedB = await call(adminB.token, 'POST', '/onboarding/sample-data');
    expect(loadedB.status).toBe(201);
    const bAccounts = await scalar(
      `select count(*)::text as v from accounts where tenant_id = $1`,
      [tenantB],
    );

    // A has loaded nothing, so A has nothing to remove — and asking must not
    // reach B's records.
    const removeA = await call(adminA.token, 'DELETE', '/onboarding/sample-data');
    expect(removeA.status).toBe(409);

    expect(
      await scalar(`select count(*)::text as v from accounts where tenant_id = $1`, [tenantB]),
    ).toBe(bAccounts);
    expect(
      await scalar(`select count(*)::text as v from sample_records where tenant_id = $1`, [
        tenantB,
      ]),
    ).not.toBe('0');
    expect(
      await scalar(`select count(*)::text as v from accounts where tenant_id = $1`, [tenantA]),
    ).toBe('0');
    const statusA = dataOf<{ sampleData: { present: boolean } }>(
      await call(adminA.token, 'GET', '/onboarding'),
    );
    expect(statusA.sampleData.present).toBe(false);
  });
});

// ===========================================================================
describe('(b) permissions', () => {
  it.each([
    ['a sales rep', () => repA],
    ['a manager', () => managerA],
  ])('%s cannot use any of it, and learns nothing from the refusal', async (_who, who) => {
    for (const route of ROUTES) {
      const response = await call(who().token, route.method, route.url, route.body);
      expect(response.status, `${route.method} ${route.url}`).toBe(403);
      expect(JSON.stringify(response.body)).not.toMatch(
        /Acme|currency|timezone|industry|checklist/i,
      );
    }
    // And nothing happened.
    expect(await scalar(`select name as v from tenants where id = $1`, [tenantA])).not.toBe(
      'Anything',
    );
  });

  it('owner and administrator are the two roles that can', async () => {
    for (const who of [ownerA, adminA]) {
      expect((await call(who.token, 'GET', '/onboarding')).status).toBe(200);
      expect((await call(who.token, 'GET', '/tenant')).status).toBe(200);
    }
  });

  it('a custom role can be given the right, and is then an administrator for this purpose', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Setup helper');
    await harness.fixtures.grant(tenantA, roleId, 'tenant_settings', 'read', 'all');
    const helper = await person(tenantA, roleId);

    expect((await call(helper.token, 'GET', '/onboarding')).status).toBe(200);
    // Read is not update.
    expect((await call(helper.token, 'PATCH', '/tenant', { name: 'Helper rename' })).status).toBe(
      403,
    );
    expect((await call(helper.token, 'POST', '/onboarding/complete')).status).toBe(403);
  });

  it('a role that can change setup but cannot create every kind of record cannot load a partial company', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Partial grants' })).tenantId;
    await harness.provision(tenant);
    const roleId = await harness.fixtures.createRole(tenant, 'Partial setup');
    await harness.fixtures.grant(tenant, roleId, 'tenant_settings', 'read', 'all');
    await harness.fixtures.grant(tenant, roleId, 'tenant_settings', 'update', 'all');
    for (const objectType of ['account', 'contact', 'lead', 'activity'] as const) {
      await harness.fixtures.grant(tenant, roleId, objectType, 'create', 'all');
    }
    // No `deal:create`.
    const partial = await person(tenant, roleId);

    const response = await call(partial.token, 'POST', '/onboarding/sample-data');

    expect(response.status).toBe(403);
    for (const table of [
      'accounts',
      'contacts',
      'leads',
      'deals',
      'activities',
      'sample_records',
    ]) {
      expect(
        await scalar(`select count(*)::text as v from ${table} where tenant_id = $1`, [tenant]),
        table,
      ).toBe('0');
    }
  });

  it('a role that cannot delete every kind of record cannot ask for sample data to be removed', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Cannot delete' })).tenantId;
    const roles = await harness.provision(tenant);
    const admin = await person(tenant, roles.get('Admin')!);
    expect((await call(admin.token, 'POST', '/onboarding/sample-data')).status).toBe(201);

    const roleId = await harness.fixtures.createRole(tenant, 'No delete');
    await harness.fixtures.grant(tenant, roleId, 'tenant_settings', 'read', 'all');
    await harness.fixtures.grant(tenant, roleId, 'tenant_settings', 'update', 'all');
    for (const objectType of ['account', 'contact', 'lead', 'activity'] as const) {
      await harness.fixtures.grant(tenant, roleId, objectType, 'delete', 'all');
    }
    const cannot = await person(tenant, roleId);

    expect((await call(cannot.token, 'DELETE', '/onboarding/sample-data')).status).toBe(403);
    const pending = await scalar(
      `select count(*)::text as v from outbox_events
       where tenant_id = $1 and event_type = 'sample_data.removal_requested.v1'`,
      [tenant],
    );
    expect(pending).toBe('0');
  });

  it('owns what it loads: sample records belong to whoever asked for them, not to a system user', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Ownership' })).tenantId;
    const roles = await harness.provision(tenant);
    const admin = await person(tenant, roles.get('Admin')!);
    await call(admin.token, 'POST', '/onboarding/sample-data');

    expect(
      await scalar(
        `select count(*)::text as v from deals where tenant_id = $1 and owner_id <> $2`,
        [tenant, admin.userId],
      ),
    ).toBe('0');
    expect(
      await scalar(
        `select count(*)::text as v from activities where tenant_id = $1 and assigned_to <> $2`,
        [tenant, admin.userId],
      ),
    ).toBe('0');
  });
});

// ===========================================================================
describe('(c) what the status reveals', () => {
  it('is booleans and counts, never the content of a record, to someone who may not read the records', async () => {
    // `tenant_settings:read` is an administrator's grant. The checklist says
    // *whether* a deal exists, not what it is, and the counts say how many sample
    // records remain, not which. A role with this grant and no right to read deals
    // sees exactly that and no more.
    const tenant = (await harness.fixtures.createTenant({ name: 'Reveals' })).tenantId;
    const roles = await harness.provision(tenant);
    const admin = await person(tenant, roles.get('Admin')!);
    await call(admin.token, 'POST', '/onboarding/sample-data');

    const roleId = await harness.fixtures.createRole(tenant, 'Setup reader only');
    await harness.fixtures.grant(tenant, roleId, 'tenant_settings', 'read', 'all');
    const reader = await person(tenant, roleId);

    const response = await call(reader.token, 'GET', '/onboarding');

    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/Sunrise|Greenleaf|Bluewave|Showroom|Kulkarni|sample\)/);
    expect(
      dataOf<{ sampleData: { counts: { deals: number } } }>(response).sampleData.counts.deals,
    ).toBe(5);
    // And the same person cannot read a single record.
    expect((await call(reader.token, 'GET', '/deals')).status).toBe(403);
  });

  it('never returns a database identifier a client could use against another endpoint', async () => {
    const text = JSON.stringify((await call(adminA.token, 'GET', '/onboarding')).body);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
