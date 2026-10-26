import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/** What saved views store, version and report. Who may see them is in `saved-views.security.spec.ts`. */

let harness: ApiHarness;
let tenantId: string;
let user: { token: string; userId: string };

interface View {
  id: string;
  name: string;
  version: number;
  visibility: string;
  filters: { q?: string; conditions: { field: string; operator: string; value: string }[] };
  columns: string[];
  sort: { field: string; direction: string }[];
  applicable: boolean;
  isMine: boolean;
}

const create = (body: Record<string, unknown>) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/saved-views',
    token: user.token,
    body: { objectType: 'contact', ...body },
  });

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const roles = await harness.provision(tenantId);
  const made = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  user = { userId: made.userId, token: await harness.signIn(made.userId, tenantId) };
  await harness.fixtures.createCustomField(tenantId, 'contact', 'region', 'text', 'Region');
});

afterAll(async () => {
  await harness.close();
});

describe('saved views', () => {
  it('stores the search, conditions, columns and sort, system and custom fields alike', async () => {
    const response = await create({
      name: 'Northern leads',
      filters: {
        q: ' priya ',
        conditions: [
          { field: 'lead_source', operator: 'eq', value: 'referral' },
          { field: 'region', operator: 'eq', value: 'North' },
          { field: 'created_at', operator: 'gte', value: '2026-01-01' },
        ],
      },
      columns: ['last_name', 'email', 'region'],
      sort: [{ field: 'created_at', direction: 'desc' }],
    });
    const view = dataOf<View>(response, 201);
    expect(view).toMatchObject({
      name: 'Northern leads',
      visibility: 'private',
      version: 1,
      applicable: true,
      isMine: true,
      columns: ['last_name', 'email', 'region'],
      sort: [{ field: 'created_at', direction: 'desc' }],
    });
    expect(view.filters.q).toBe('priya');
    expect(view.filters.conditions).toHaveLength(3);

    const listed = dataOf<View[]>(
      await request(harness, {
        method: 'GET',
        url: '/api/v1/saved-views?objectType=contact',
        token: user.token,
      }),
    );
    expect(listed.find((candidate) => candidate.id === view.id)).toEqual(view);
  });

  it('refuses a name already used by the same person for the same list', async () => {
    expect((await create({ name: 'Duplicate' })).status).toBe(201);
    const again = await create({ name: 'Duplicate' });
    expect(again.status).toBe(409);
    // The same name on another list is fine.
    const other = await create({ name: 'Duplicate', objectType: 'account' });
    expect(other.status).toBe(201);
  });

  it('refuses a malformed value, an unknown operator, an unknown key and a blank name', async () => {
    const bad: Record<string, unknown>[] = [
      {
        name: 'Bad number',
        filters: { conditions: [{ field: 'created_at', operator: 'gte', value: 'yesterday' }] },
      },
      {
        name: 'Bad operator',
        filters: { conditions: [{ field: 'last_name', operator: 'sounds_like', value: 'x' }] },
      },
      { name: 'Bad key', filters: { conditions: [], sql: 'drop table contacts' } },
      { name: '   ' },
      {
        name: 'Two sorts',
        sort: [
          { field: 'last_name', direction: 'asc' },
          { field: 'email', direction: 'asc' },
        ],
      },
      {
        name: 'Unknown field',
        filters: { conditions: [{ field: 'nope', operator: 'eq', value: 'x' }] },
      },
      { name: 'Twice', columns: ['last_name', 'last_name'] },
      { name: 'Sort by unsortable', sort: [{ field: 'nope', direction: 'asc' }] },
      { name: 'Object', objectType: 'activity' },
    ];
    for (const body of bad) {
      const response = await create(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('versions every edit, and a stale version is a 409 that changes nothing', async () => {
    const made = dataOf<View>(await create({ name: 'Versioned' }), 201);

    const renamed = dataOf<View>(
      await request(harness, {
        method: 'PATCH',
        url: `/api/v1/saved-views/${made.id}`,
        token: user.token,
        body: { name: 'Renamed', version: made.version },
      }),
    );
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2 });

    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: user.token,
      body: { name: 'Stale write', version: made.version },
    });
    expect(stale.status).toBe(409);
    expect((stale.body['error'] as { code: string }).code).toBe('VERSION_CONFLICT');

    const staleDelete = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/saved-views/${made.id}?version=${made.version}`,
      token: user.token,
    });
    expect(staleDelete.status).toBe(409);

    const listed = dataOf<View[]>(
      await request(harness, {
        method: 'GET',
        url: '/api/v1/saved-views?objectType=contact',
        token: user.token,
      }),
    );
    expect(listed.find((view) => view.id === made.id)?.name).toBe('Renamed');
  });

  it('deletes with the right version, audits and announces create, update and delete', async () => {
    const made = dataOf<View>(await create({ name: 'Short lived' }), 201);
    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: user.token,
      body: { columns: ['last_name'], version: made.version },
    });
    const gone = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/saved-views/${made.id}?version=2`,
      token: user.token,
    });
    expect(gone.status).toBe(204);

    const again = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/saved-views/${made.id}?version=2`,
      token: user.token,
    });
    expect(again.status).toBe(404);

    const audit = (await harness.fixtures.auditEntries(tenantId, 'saved_view')).filter(
      (entry) => entry.recordId === made.id,
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual(['create', 'delete', 'update']);
    const types = await harness.fixtures.outboxEventTypes(tenantId);
    expect(types).toEqual(
      expect.arrayContaining([
        'saved_view.created.v1',
        'saved_view.updated.v1',
        'saved_view.deleted.v1',
      ]),
    );
  });

  it('caps how many views one person keeps of one kind', async () => {
    const role = await harness.fixtures.createRole(tenantId, 'Collector');
    await harness.fixtures.grantAll(tenantId, role, 'deal', 'own');
    const made = await harness.fixtures.createUser(tenantId, role);
    const token = await harness.signIn(made.userId, tenantId);

    let last = 201;
    for (let index = 0; index < 51 && last === 201; index += 1) {
      const response = await request(harness, {
        method: 'POST',
        url: '/api/v1/saved-views',
        token,
        body: { objectType: 'deal', name: `View ${index}` },
      });
      last = response.status;
      if (index < 50) expect(last).toBe(201);
    }
    expect(last).toBe(422);
  }, 60_000);
});
