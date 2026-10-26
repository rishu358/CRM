import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10), for saved views, plus the rules
 * that are particular to a thing people share (ADR-0056):
 *
 *   (a) tenant A cannot list, read, update or delete tenant B's views
 *   (b) a view is shown only to those its visibility names: private, team, tenant
 *   (c) a field hidden from a role cannot be put in a view by that role, and a view that uses one
 *       is not usable by it and does not name it
 *   (d) unauthenticated requests get 401
 *
 * All through the real HTTP stack and the real row-level-security policies of migration 0023.
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let teammateA: { token: string; userId: string };
let outsiderA: { token: string; userId: string };
let limitedA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

const url = (query = 'objectType=contact') => `/api/v1/saved-views?${query}`;

interface ViewBody {
  id: string;
  name: string;
  visibility: string;
  isMine: boolean;
  applicable: boolean;
  version: number;
  filters: { q?: string; conditions: { field: string; operator: string; value: string }[] };
  columns: string[];
  sort: { field: string; direction: string }[];
}

async function createView(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return request(harness, {
    method: 'POST',
    url: '/api/v1/saved-views',
    token,
    body: { objectType: 'contact', filters: { conditions: [] }, ...body },
  });
}

async function listNames(token: string, query = 'objectType=contact'): Promise<string[]> {
  const response = await request(harness, { method: 'GET', url: url(query), token });
  return dataOf<ViewBody[]>(response).map((view) => view.name);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  const make = async (tenantId: string, roleId: string) => {
    const user = await harness.fixtures.createUser(tenantId, roleId);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };

  adminA = await make(tenantA, rolesA.get('Admin')!);
  repA = await make(tenantA, rolesA.get('Sales Rep')!);
  teammateA = await make(tenantA, rolesA.get('Sales Rep')!);
  outsiderA = await make(tenantA, rolesA.get('Sales Rep')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);

  // repA and teammateA share a team; outsiderA is on none.
  await harness.fixtures.createTeam(tenantA, 'Sales North', [repA.userId, teammateA.userId]);

  // A role that can use contacts but may not see their email address.
  const limitedRole = await harness.fixtures.createRole(tenantA, 'Limited');
  await harness.fixtures.grantAll(tenantA, limitedRole, 'contact', 'own');
  await harness.fixtures.setFieldPermission(tenantA, limitedRole, 'contact', 'email', 'hidden');
  limitedA = await make(tenantA, limitedRole);
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every verb with no credentials', async () => {
    const calls = [
      { method: 'GET', url: url() },
      { method: 'POST', url: '/api/v1/saved-views', body: { objectType: 'contact', name: 'x' } },
      { method: 'PATCH', url: `/api/v1/saved-views/${crypto.randomUUID()}`, body: { version: 1 } },
      { method: 'DELETE', url: `/api/v1/saved-views/${crypto.randomUUID()}?version=1` },
    ] as const;
    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B views', () => {
  let viewB: string;

  beforeAll(async () => {
    const response = await createView(adminB.token, {
      name: 'Rival hot list',
      visibility: 'tenant',
    });
    viewB = dataOf<ViewBody>(response).id;
  });

  it('does not list them', async () => {
    expect(await listNames(adminA.token)).not.toContain('Rival hot list');
  });

  it('answers 404, not 403, to an update or a delete of one', async () => {
    const patch = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${viewB}`,
      token: adminA.token,
      body: { name: 'Mine now', version: 1 },
    });
    expect(patch.status).toBe(404);

    const remove = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/saved-views/${viewB}?version=1`,
      token: adminA.token,
    });
    expect(remove.status).toBe(404);

    // And the view is untouched.
    expect(await listNames(adminB.token)).toContain('Rival hot list');
  });
});

describe('(b) a view is shown only to those its visibility names', () => {
  it('keeps a private view private, and answers 404 to a colleague who guesses its id', async () => {
    const made = dataOf<ViewBody>(await createView(repA.token, { name: 'Only mine' }));
    expect(made.visibility).toBe('private');

    expect(await listNames(repA.token)).toContain('Only mine');
    expect(await listNames(teammateA.token)).not.toContain('Only mine');
    expect(await listNames(adminA.token)).not.toContain('Only mine');

    const patch = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: teammateA.token,
      body: { name: 'Taken', version: made.version },
    });
    expect(patch.status).toBe(404);
  });

  it('shows a team view to the team and to nobody else, who may use it but not change it', async () => {
    const made = dataOf<ViewBody>(
      await createView(repA.token, { name: 'North pipeline', visibility: 'team' }),
    );

    const seen = dataOf<ViewBody[]>(
      await request(harness, { method: 'GET', url: url(), token: teammateA.token }),
    ).find((view) => view.id === made.id);
    expect(seen?.isMine).toBe(false);

    expect(await listNames(outsiderA.token)).not.toContain('North pipeline');
    expect(await listNames(adminA.token)).not.toContain('North pipeline');

    // Visible but not theirs: 403, because they already know it exists.
    const patch = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: teammateA.token,
      body: { name: 'Mine', version: made.version },
    });
    expect(patch.status).toBe(403);
    const remove = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/saved-views/${made.id}?version=${made.version}`,
      token: teammateA.token,
    });
    expect(remove.status).toBe(403);
    expect(await listNames(repA.token)).toContain('North pipeline');
  });

  it('refuses to share with a team the person is not on', async () => {
    const response = await createView(outsiderA.token, { name: 'Ghost team', visibility: 'team' });
    expect(response.status).toBe(422);
  });

  it('lets only a holder of the company-settings grant share a view with everyone', async () => {
    const denied = await createView(repA.token, { name: 'For all', visibility: 'tenant' });
    expect(denied.status).toBe(403);

    const made = await createView(adminA.token, { name: 'Everyone sees', visibility: 'tenant' });
    expect(made.status).toBe(201);
    expect(await listNames(outsiderA.token)).toContain('Everyone sees');
  });

  it('does not let a person move a view into somebody else tenant by editing', async () => {
    // The database refuses a write to a row that is not the caller's, whatever the service says.
    const made = dataOf<ViewBody>(await createView(repA.token, { name: 'Edit me' }));
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: repA.token,
      body: { visibility: 'tenant', version: made.version },
    });
    expect(response.status).toBe(403);
  });

  it('keeps views of one object type out of another object type list', async () => {
    await createView(repA.token, { name: 'Deals only', objectType: 'deal' });
    expect(await listNames(repA.token, 'objectType=contact')).not.toContain('Deals only');
    expect(await listNames(repA.token, 'objectType=deal')).toContain('Deals only');
  });

  it('is refused to a caller who cannot read that object type at all', async () => {
    const role = await harness.fixtures.createRole(tenantA, 'No deals');
    await harness.fixtures.grantAll(tenantA, role, 'contact', 'own');
    const user = await harness.fixtures.createUser(tenantA, role);
    const token = await harness.signIn(user.userId, tenantA);

    const list = await request(harness, { method: 'GET', url: url('objectType=deal'), token });
    expect(list.status).toBe(403);
    const create = await createView(token, { name: 'Sneaky', objectType: 'deal' });
    expect(create.status).toBe(403);
  });
});

describe('(c) hidden fields cannot be used in a view', () => {
  it('rejects a condition, a column and a sort on a field hidden from the caller', async () => {
    const detailsOf = (response: { status: number; body: Record<string, unknown> }) => {
      expect(response.status).toBe(422);
      const error = response.body['error'] as { details: unknown };
      return JSON.stringify(error.details);
    };

    detailsOf(
      await createView(limitedA.token, {
        name: 'By email',
        filters: { conditions: [{ field: 'email', operator: 'contains', value: 'acme' }] },
      }),
    );
    detailsOf(await createView(limitedA.token, { name: 'Email column', columns: ['email'] }));
    detailsOf(
      await createView(limitedA.token, {
        name: 'Email sort',
        sort: [{ field: 'email', direction: 'asc' }],
      }),
    );

    // The answer for a hidden field is the answer for one that does not exist.
    const hidden = detailsOf(
      await createView(limitedA.token, {
        name: 'Hidden',
        columns: ['email'],
      }),
    );
    const missing = detailsOf(
      await createView(limitedA.token, { name: 'Missing', columns: ['no_such_field'] }),
    );
    expect(hidden.replace('email', 'X')).toBe(missing.replace('no_such_field', 'X'));
  });

  it('lists a shared view that uses a hidden field as unusable, without naming the field or its value', async () => {
    const made = await createView(adminA.token, {
      name: 'Gmail contacts',
      visibility: 'tenant',
      filters: {
        q: 'zzsecret',
        conditions: [{ field: 'email', operator: 'contains', value: 'gmail' }],
      },
      columns: ['last_name', 'email'],
      sort: [{ field: 'email', direction: 'asc' }],
    });
    expect(made.status).toBe(201);

    const response = await request(harness, { method: 'GET', url: url(), token: limitedA.token });
    const view = dataOf<ViewBody[]>(response).find(
      (candidate) => candidate.name === 'Gmail contacts',
    );
    expect(view?.applicable).toBe(false);
    expect(view?.filters.conditions).toEqual([]);
    expect(view?.sort).toEqual([]);
    expect(view?.columns).toEqual(['last_name']);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('gmail');
    expect(body).not.toContain('zzsecret');
    expect(body).not.toContain('"email"');

    // The author, who may read email, still sees all of it.
    const mine = dataOf<ViewBody[]>(
      await request(harness, { method: 'GET', url: url(), token: adminA.token }),
    ).find((candidate) => candidate.name === 'Gmail contacts');
    expect(mine?.applicable).toBe(true);
    expect(mine?.filters.conditions).toHaveLength(1);
  });

  it('holds an edit to a view to what is being saved, not only what changed', async () => {
    const made = dataOf<ViewBody>(
      await createView(limitedA.token, {
        name: 'Clean view',
        filters: { conditions: [{ field: 'last_name', operator: 'starts_with', value: 'S' }] },
      }),
    );
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/saved-views/${made.id}`,
      token: limitedA.token,
      body: { columns: ['email'], version: made.version },
    });
    expect(response.status).toBe(422);
  });
});
