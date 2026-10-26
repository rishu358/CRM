import { parseFilter, parseSort } from '@crm/contracts';
import {
  EXPORT_MATCH_LIMIT,
  isUsableSearchTerm,
  newId,
  QUERY_COLUMNS,
  searchableFieldKeys,
  type ExportableObjectType,
  type RecordConstraint,
} from '@crm/core';
import {
  createDbClient,
  loadFieldDefinitions,
  planQuery,
  PostgresSearchProvider,
  selectPlanPage,
  withTenant,
  type DbClient,
} from '@crm/db';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';
import { allowedSortKeys as accountSortKeys } from '../accounts/accounts.sql-helpers.js';
import { allowedSortKeys as contactSortKeys } from '../contacts/contacts.sql-helpers.js';
import { allowedSortKeys as dealSortKeys } from '../deals/deals.sql-helpers.js';
import { allowedSortKeys as leadSortKeys } from '../leads/leads.sql-helpers.js';

/**
 * An export is a list query run to completion, so it must return **the rows the
 * list returns**, in the order the list returns them (MVP_SPEC §M8: "respects
 * filters + permissions").
 *
 * The export's filter/sort SQL lives in `@crm/db` (`planQuery`) because the
 * worker that runs exports cannot import the API, which means it is a copy of
 * what each module's `sql-helpers.ts` builds (ADR-0029). A copy can drift. This
 * file is the guard: it sends the same filters, sorts and searches through the
 * real list endpoint and through the export's builder and fails if either
 *
 *   - returns different rows, or the same rows in a different order, across page
 *     boundaries and through ties and NULLs; or
 *   - accepts a different set of fields to filter and sort on; or
 *   - disagrees about what is an invalid value.
 *
 * If a module's list gains a filter, a column or a rule, this goes red until
 * `planQuery` learns it too. That is the whole mechanism.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;
let client: DbClient;

let tenantId: string;
let admin: { token: string; userId: string };
let rep: { token: string; userId: string };
let otherRep: { token: string; userId: string };

const PAGE = 7;

async function userWithRole(roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 3 });
  superuser = typedPool(rawSuperuser);
  client = createDbClient({ connectionString: urls.app, maxConnections: 3 });

  tenantId = (await harness.fixtures.createTenant({ name: 'Export Parity' })).tenantId;
  const roles = await harness.provision(tenantId);
  admin = await userWithRole(roles.get('Admin')!);
  rep = await userWithRole(roles.get('Sales Rep')!);
  otherRep = await userWithRole(roles.get('Sales Rep')!);

  // A custom field on every object, so custom-field filters and sorts are covered.
  for (const objectType of ['contact', 'account', 'lead', 'deal']) {
    await superuser.query(
      `insert into field_definitions (id, tenant_id, object_type, key, label, type, position, is_system, is_active)
       values ($1, $2, $3, 'segment', 'Segment', 'text', 900, false, true)`,
      [newId(), tenantId, objectType],
    );
  }

  const owners = [rep.userId, otherRep.userId];
  const pick = <T>(values: readonly T[], i: number): T => values[i % values.length] as T;

  // Contacts: 40 rows with ties on created_at and NULLs in every optional column.
  for (let i = 0; i < 40; i += 1) {
    await superuser.query(
      `insert into contacts (id, tenant_id, owner_id, first_name, last_name, email, phone, title,
                             lead_source, custom_fields, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11),
               now() - make_interval(mins => $12))`,
      [
        newId(),
        tenantId,
        pick(owners, i),
        i % 7 === 0 ? null : `First${i}`,
        pick(['Adams', 'Baker', 'Chen', 'Diaz', 'Evans'], i),
        i % 4 === 0 ? null : `c${i}@${i % 2 === 0 ? 'alpha' : 'beta'}.example`,
        i % 3 === 0 ? null : `+91987654${String(3000 + i)}`,
        i % 5 === 0 ? null : pick(['CEO', 'CTO', 'VP'], i),
        i % 6 === 0 ? null : pick(['referral', 'website', 'walk_in'], i),
        JSON.stringify(i % 6 === 0 ? {} : { segment: pick(['gold', 'silver', 'bronze'], i) }),
        i % 10,
        (i * 3) % 17,
      ],
    );
  }

  for (let i = 0; i < 30; i += 1) {
    await superuser.query(
      `insert into accounts (id, tenant_id, owner_id, name, domain, industry, email, employee_count,
                             annual_revenue_minor, annual_revenue_currency, custom_fields, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(mins => $12))`,
      [
        newId(),
        tenantId,
        pick(owners, i),
        `${pick(['Acme', 'Globex', 'Initech', 'Umbrella'], i)} ${i}`,
        i % 4 === 0 ? null : `co${i}.example`,
        i % 3 === 0 ? null : pick(['Retail', 'Finance', 'Health'], i),
        i % 5 === 0 ? null : `info@co${i}.example`,
        i % 6 === 0 ? null : (i * 13) % 500,
        i % 7 === 0 ? null : String(((i * 977) % 100) * 100_000),
        i % 7 === 0 ? null : 'INR',
        JSON.stringify(i % 4 === 0 ? {} : { segment: pick(['gold', 'silver'], i) }),
        i % 8,
      ],
    );
  }

  for (let i = 0; i < 30; i += 1) {
    await superuser.query(
      `insert into leads (id, tenant_id, owner_id, first_name, last_name, company, email, phone, source,
                          status, custom_fields, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(mins => $12))`,
      [
        newId(),
        tenantId,
        pick(owners, i),
        i % 5 === 0 ? null : `LFirst${i}`,
        pick(['Kapoor', 'Lal', 'Mehta', 'Nair'], i),
        i % 3 === 0 ? null : pick(['Acme', 'Globex', 'Initech'], i),
        i % 4 === 0 ? null : `l${i}@lead.example`,
        i % 2 === 0 ? null : `+91876543${String(2000 + i)}`,
        i % 6 === 0 ? null : pick(['referral', 'website', 'social'], i),
        pick(['new', 'contacted', 'qualified', 'unqualified'], i),
        JSON.stringify(i % 5 === 0 ? {} : { segment: pick(['gold', 'silver'], i) }),
        i % 9,
      ],
    );
  }

  const [pipeline] = await harness.fixtures.pipelinesFor(tenantId);
  for (let i = 0; i < 30; i += 1) {
    const stage = pipeline!.stages[i % pipeline!.stages.length]!;
    await superuser.query(
      `insert into deals (id, tenant_id, owner_id, name, pipeline_id, stage_id, amount_minor, currency,
                          probability, expected_close_date, lost_reason, closed_at, custom_fields, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() - make_interval(mins => $14))`,
      [
        newId(),
        tenantId,
        pick(owners, i),
        `Deal ${pick(['Alpha', 'Beta', 'Gamma'], i)} ${i}`,
        pipeline!.id,
        stage.id,
        i % 5 === 0 ? null : String(((i * 311) % 50) * 100_000),
        i % 5 === 0 ? null : 'INR',
        // Won deals are at 100 and lost ones at 0; open ones vary (and tie).
        stage.stageType === 'won' ? 100 : stage.stageType === 'lost' ? 0 : 1 + ((i * 7) % 90),
        i % 4 === 0
          ? null
          : `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        // The database requires a lost reason on a lost deal, and refuses one (or a
        // close time) on an open deal.
        stage.stageType === 'lost' ? pick(['budget', 'timing'], Math.floor(i / 6)) : null,
        stage.stageType === 'open' ? null : new Date(Date.now() - i * 60_000),
        JSON.stringify(i % 3 === 0 ? {} : { segment: pick(['gold', 'silver'], i) }),
        i % 6,
      ],
    );
  }

  // The rows above were written straight into the tables, so nothing has indexed them, and a list's
  // search box (and an export's) is now answered by the search index (ADR-0041 §5).
  await harness.indexForSearch(tenantId);
});

afterAll(async () => {
  await Promise.all([rawSuperuser.end(), client.close(), harness.close()]);
});

const ROUTES: Record<ExportableObjectType, string> = {
  contact: '/api/v1/contacts',
  account: '/api/v1/accounts',
  lead: '/api/v1/leads',
  deal: '/api/v1/deals',
};

interface Query {
  filter?: string[];
  sort?: string;
  q?: string;
}

/** The ids the list endpoint returns, walking every page by cursor. */
async function viaList(
  objectType: ExportableObjectType,
  token: string,
  query: Query,
): Promise<{ ids: string[]; status: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    for (const filter of query.filter ?? []) params.append('filter', filter);
    if (query.sort !== undefined) params.set('sort', query.sort);
    if (query.q !== undefined) params.set('q', query.q);
    if (cursor !== null) params.set('cursor', cursor);

    const response = await request(harness, {
      method: 'GET',
      url: `${ROUTES[objectType]}?${params.toString()}`,
      token,
    });
    if (response.status !== 200) return { ids, status: response.status };
    ids.push(...dataOf<{ id: string }[]>(response).map((row) => row.id));
    const meta = response.body['meta'] as { nextCursor: string | null; hasMore: boolean };
    if (!meta.hasMore) break;
    cursor = meta.nextCursor;
  }
  return { ids, status: 200 };
}

/** The ids an export would write, paging the way the worker does. */
async function viaExport(
  objectType: ExportableObjectType,
  userId: string,
  constraint: RecordConstraint,
  query: Query,
): Promise<{ ids: string[]; rejected: boolean }> {
  try {
    return await withTenant(client.db, { tenantId, userId }, async (tx) => {
      const fields = await loadFieldDefinitions(tx, tenantId, objectType);
      const filters = (query.filter ?? []).map((raw) => {
        const parsed = parseFilter(raw);
        if (parsed === null) throw new Error('malformed');
        return parsed;
      });
      // As the export handler does: the search is answered by the seam, and the plan narrows to its ids.
      const matchedIds =
        query.q === undefined || !isUsableSearchTerm(query.q)
          ? undefined
          : (
              await new PostgresSearchProvider().matchRecordIds(tx, {
                tenantId: tenantId as never,
                term: query.q,
                scope: { objectType, constraint, fieldKeys: searchableFieldKeys(objectType) },
                limit: EXPORT_MATCH_LIMIT,
              })
            ).recordIds;
      const plan = planQuery(
        objectType,
        fields,
        {
          filters,
          sort: query.sort === undefined ? undefined : parseSort(query.sort),
          matchedIds,
        },
        constraint,
      );

      const ids: string[] = [];
      let cursor: { value: string | null; id: string } | null = null;
      for (let page = 0; page < 40; page += 1) {
        const rows = await selectPlanPage(tx, tenantId, plan, { limit: PAGE, cursor });
        if (rows.length === 0) break;
        ids.push(...rows.map((row) => String(row['id'])));
        const last = rows[rows.length - 1]!;
        if (rows.length < PAGE) break;
        cursor = { value: last.cursorValue, id: String(last['id']) };
      }
      return { ids, rejected: false };
    });
  } catch {
    return { ids: [], rejected: true };
  }
}

const ALL: RecordConstraint = { kind: 'all' };

async function expectParity(
  objectType: ExportableObjectType,
  query: Query,
  as: { token: string; userId: string; constraint: RecordConstraint } = {
    token: admin.token,
    userId: admin.userId,
    constraint: ALL,
  },
): Promise<number> {
  const list = await viaList(objectType, as.token, query);
  const exported = await viaExport(objectType, as.userId, as.constraint, query);
  const label = `${objectType} ${JSON.stringify(query)}`;
  expect(list.status, `${label}: the list should accept this`).toBe(200);
  expect(exported.rejected, `${label}: the export should accept this`).toBe(false);
  expect(exported.ids, label).toEqual(list.ids);
  return list.ids.length;
}

async function expectBothReject(objectType: ExportableObjectType, query: Query): Promise<void> {
  const list = await viaList(objectType, admin.token, query);
  const exported = await viaExport(objectType, admin.userId, ALL, query);
  const label = `${objectType} ${JSON.stringify(query)}`;
  expect(list.status, `${label}: list`).toBe(422);
  expect(exported.rejected, `${label}: export`).toBe(true);
}

describe('the sets of fields a list and an export accept are the same', () => {
  const MODULES: Record<ExportableObjectType, (fields: never[]) => string[]> = {
    contact: contactSortKeys,
    account: accountSortKeys,
    lead: leadSortKeys,
    deal: dealSortKeys,
  };

  it.each(['contact', 'account', 'lead', 'deal'] as const)('%s', (objectType) => {
    // With no custom fields, what is left is exactly the standard columns each
    // module whitelists. `QUERY_COLUMNS` (the API's validation, the worker's
    // column map) must be that set.
    expect(Object.keys(QUERY_COLUMNS[objectType]).sort()).toEqual(
      [...MODULES[objectType]([])].sort(),
    );
  });
});

describe('contacts: the export returns what the list returns, in the same order', () => {
  const filters: [string, Query][] = [
    ['no filter, default order', {}],
    ['eq on text', { filter: ['last_name:eq:Chen'] }],
    ['neq keeps the NULLs (is distinct from)', { filter: ['title:neq:CEO'] }],
    ['contains', { filter: ['email:contains:alpha'] }],
    ['starts_with, case-insensitive', { filter: ['last_name:starts_with:ba'] }],
    ['in', { filter: ['last_name:in:Adams,Evans'] }],
    ['is_null', { filter: ['phone:is_null:'] }],
    ['is_not_null', { filter: ['title:is_not_null:'] }],
    ['a LIKE wildcard is data, not a wildcard', { filter: ['last_name:contains:%'] }],
    ['a custom field', { filter: ['segment:eq:gold'] }],
    ['a custom field, contains', { filter: ['segment:contains:ol'] }],
    ['a custom field that is missing on some rows', { filter: ['segment:is_null:'] }],
    ['timestamp comparison', { filter: ['created_at:gte:2000-01-01'] }],
    ['two filters together', { filter: ['title:eq:CTO', 'email:contains:beta'] }],
    ['search', { q: 'chen' }],
    ['search with a filter', { q: 'ba', filter: ['title:is_not_null:'] }],
  ];
  it.each(filters)('%s', async (name, query) => {
    const count = await expectParity('contact', query);
    // Two empty lists agreeing proves nothing; only the wildcard case is *meant* to be empty.
    if (!name.includes('wildcard')) expect(count, name).toBeGreaterThan(0);
  });

  const sorts: [string, Query][] = [
    ['by a text column', { sort: 'last_name' }],
    ['descending', { sort: '-last_name' }],
    ['by a nullable column, nulls last when ascending', { sort: 'title' }],
    ['by a nullable column, nulls first when descending', { sort: '-title' }],
    ['by a nullable column with ties across pages', { sort: 'lead_source' }],
    ['by a custom field', { sort: 'segment' }],
    ['by a custom field, descending', { sort: '-segment' }],
    ['by created_at, where rows tie', { sort: '-created_at' }],
    ['filtered and sorted', { filter: ['title:is_not_null:'], sort: '-last_name' }],
  ];
  it.each(sorts)('sort %s', async (_name, query) => {
    const count = await expectParity('contact', query);
    expect(count).toBeGreaterThan(PAGE); // genuinely crosses page boundaries
  });

  it('the whole table is returned exactly once', async () => {
    const list = await viaList('contact', admin.token, {});
    expect(new Set(list.ids).size).toBe(list.ids.length);
    expect(list.ids).toHaveLength(40);
  });
});

describe('record scope is the same constraint, applied the same way', () => {
  it('an `own`-scope user sees the same rows in a list and in an export', async () => {
    const own: RecordConstraint = { kind: 'own', userId: rep.userId as never };
    for (const query of [{}, { sort: '-title' }, { filter: ['title:neq:CEO'] }, { q: 'ba' }]) {
      const count = await expectParity('contact', query, {
        token: rep.token,
        userId: rep.userId,
        constraint: own,
      });
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(40);
    }
  });

  it('a `team`-scope constraint matches too', async () => {
    const team = await harness.fixtures.createTeam(tenantId, `parity-${newId().slice(-6)}`, [
      rep.userId,
    ]);
    void team;
    const constraint: RecordConstraint = {
      kind: 'team',
      userId: rep.userId as never,
      teamIds: [team as never],
    };
    // The list endpoint resolves team scope from the actor's real teams.
    const roleId = await harness.fixtures.createRole(tenantId, `team-reader-${newId().slice(-6)}`);
    await harness.fixtures.grant(tenantId, roleId, 'contact', 'read', 'team');
    const member = await userWithRole(roleId);
    await harness.fixtures.createTeam(tenantId, `parity2-${newId().slice(-6)}`, [
      member.userId,
      otherRep.userId,
    ]);
    const teams = await superuser.query('select team_id from team_members where user_id = $1', [
      member.userId,
    ]);
    const memberConstraint: RecordConstraint = {
      kind: 'team',
      userId: member.userId as never,
      teamIds: teams.rows.map((row) => row['team_id'] as never),
    };
    void constraint;
    const count = await expectParity(
      'contact',
      { sort: 'last_name' },
      {
        token: member.token,
        userId: member.userId,
        constraint: memberConstraint,
      },
    );
    expect(count).toBeGreaterThan(0);
  });
});

describe('accounts', () => {
  const cases: [string, Query][] = [
    ['default', {}],
    ['name contains', { filter: ['name:contains:Acme'] }],
    ['a number kind', { filter: ['employee_count:gt:100'] }],
    ['a number kind, in', { filter: ['employee_count:in:13,26,39'] }],
    ['a nullable number, is_null', { filter: ['employee_count:is_null:'] }],
    ['money by minor units', { filter: ['annual_revenue:gte:2000000'] }],
    ['a uuid column, is_null', { filter: ['parent_account_id:is_null:'] }],
    ['a custom field', { filter: ['segment:eq:silver'] }],
    ['search', { q: 'globex' }],
    ['sort by a number with nulls', { sort: 'employee_count' }],
    ['sort by a number with nulls, descending', { sort: '-employee_count' }],
    ['sort by domain with nulls', { sort: 'domain' }],
    ['sort by a custom field', { sort: '-segment' }],
  ];
  it.each(cases)('%s', async (name, query) => {
    expect(await expectParity('account', query), name).toBeGreaterThan(0);
  });

  it.each([
    ['a non-number for a number', { filter: ['employee_count:eq:abc'] }],
    ['substring on a number', { filter: ['employee_count:contains:1'] }],
    ['a non-uuid for a uuid', { filter: ['parent_account_id:eq:nope'] }],
    ['an unknown field', { filter: ['nope:eq:1'] }],
  ] as [string, Query][])('both refuse %s', async (_name, query) => {
    await expectBothReject('account', query);
  });
});

describe('leads', () => {
  const cases: [string, Query][] = [
    ['default', {}],
    ['status eq', { filter: ['status:eq:qualified'] }],
    ['status in', { filter: ['status:in:new,contacted'] }],
    ['company nullable', { filter: ['company:is_null:'] }],
    ['converted_at is null', { filter: ['converted_at:is_null:'] }],
    ['custom', { filter: ['segment:eq:gold'] }],
    ['search', { q: 'kapoor' }],
    ['sort by company with nulls', { sort: 'company' }],
    ['sort by status with ties', { sort: '-status' }],
    ['sort by source, nullable', { sort: '-source' }],
  ];
  it.each(cases)('%s', async (name, query) => {
    expect(await expectParity('lead', query), name).toBeGreaterThan(0);
  });
});

describe('deals', () => {
  const cases: [string, Query][] = [
    ['default', {}],
    ['name contains', { filter: ['name:contains:Beta'] }],
    ['amount (minor units) gt', { filter: ['amount:gt:1000000'] }],
    ['amount is_null', { filter: ['amount:is_null:'] }],
    ['probability lte', { filter: ['probability:lte:40'] }],
    ['a date column', { filter: ['expected_close_date:gte:2026-06-01'] }],
    ['a date column is_null', { filter: ['expected_close_date:is_null:'] }],
    ['lost_reason', { filter: ['lost_reason:eq:budget'] }],
    ['custom', { filter: ['segment:eq:silver'] }],
    ['search', { q: 'gamma' }],
    ['sort by amount with nulls', { sort: 'amount' }],
    ['sort by amount descending', { sort: '-amount' }],
    ['sort by date with nulls', { sort: 'expected_close_date' }],
    ['sort by probability with ties', { sort: '-probability' }],
  ];
  it.each(cases)('%s', async (name, query) => {
    expect(await expectParity('deal', query), name).toBeGreaterThan(0);
  });

  it.each([
    ['a non-date for a date', { filter: ['expected_close_date:eq:soon'] }],
    ['a non-number for amount', { filter: ['amount:gt:lots'] }],
  ] as [string, Query][])('both refuse %s', async (_name, query) => {
    await expectBothReject('deal', query);
  });
});
