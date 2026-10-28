import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for tags (ADR-0063):
 *
 *   (a) tenant A cannot see, rename, recolour, delete or filter by tenant B's tags
 *   (b) a caller with `own` scope sees the tags of their own records only, and cannot manage tags
 *   (c) tags are not a field: hiding a field changes nothing about them, and a caller with no access to
 *       any record kind is not shown the workspace's tag names
 *   (d) unauthenticated requests get 401
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let repA2: { token: string; userId: string };
let nobodyA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

let repContact: string;
let colleagueContact: string;
let contactB: string;

interface Tag {
  id: string;
  name: string;
  version: number;
}

const tagAdd = (token: string, id: string, tags: string[]) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/bulk-actions',
    token,
    body: { objectType: 'contact', action: 'tag_add', tags, target: { kind: 'ids', ids: [id] } },
  });

const tagsFor = async (token: string) =>
  dataOf<Tag[]>(await request(harness, { method: 'GET', url: '/api/v1/tags', token }));

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
  repA2 = await make(tenantA, rolesA.get('Sales Rep')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);
  nobodyA = await make(tenantA, await harness.fixtures.createRole(tenantA, 'Nobody'));

  repContact = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Sharma',
  });
  colleagueContact = await harness.fixtures.createContact(tenantA, {
    ownerId: repA2.userId,
    lastName: 'Iyer',
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
  });

  expect((await tagAdd(repA.token, repContact, ['Mine'])).status).toBe(200);
  expect((await tagAdd(repA2.token, colleagueContact, ['Theirs'])).status).toBe(200);
  expect((await tagAdd(adminB.token, contactB, ['Rival secret'])).status).toBe(200);
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every tag route with no credentials, or a made-up token', async () => {
    const id = crypto.randomUUID();
    const routes = [
      { method: 'GET', url: '/api/v1/tags' },
      { method: 'GET', url: '/api/v1/tags/usage' },
      { method: 'PATCH', url: `/api/v1/tags/${id}`, body: { name: 'x', version: 1 } },
      { method: 'DELETE', url: `/api/v1/tags/${id}?version=1` },
    ] as const;
    for (const route of routes) {
      expect((await request(harness, route)).status, route.url).toBe(401);
      expect(
        (await request(harness, { ...route, token: 'not-a-real-session-token-but-long-enough' }))
          .status,
        route.url,
      ).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('never lists, counts or shows a tag of another workspace', async () => {
    expect((await tagsFor(adminA.token)).map((tag) => tag.name)).not.toContain('Rival secret');
    const usage = dataOf<{ name: string }[]>(
      await request(harness, { method: 'GET', url: '/api/v1/tags/usage', token: adminA.token }),
    );
    expect(usage.map((row) => row.name)).not.toContain('Rival secret');
    expect((await tagsFor(adminB.token)).map((tag) => tag.name)).toEqual(['Rival secret']);
  });

  it('answers 404 to a rename or delete of a tag that belongs to another workspace', async () => {
    const theirs = (await tagsFor(adminB.token))[0]!;
    const patch = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/tags/${theirs.id}`,
      token: adminA.token,
      body: { name: 'Hijacked', version: theirs.version },
    });
    expect(patch.status).toBe(404);
    const del = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/tags/${theirs.id}?version=${theirs.version}`,
      token: adminA.token,
    });
    expect(del.status).toBe(404);
    // The same answer as for an id that never existed, so the id cannot be probed.
    const never = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/tags/${crypto.randomUUID()}?version=1`,
      token: adminA.token,
    });
    expect(never.status).toBe(404);
    expect(await tagsFor(adminB.token)).toEqual([
      expect.objectContaining({ name: 'Rival secret' }),
    ]);
  });

  it('matches nothing in its own list when filtering by another workspace’s tag', async () => {
    const theirs = (await tagsFor(adminB.token))[0]!;
    for (const operator of ['has_any']) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts?filter=${encodeURIComponent(`tags:${operator}:${theirs.id}`)}`,
        token: adminA.token,
      });
      expect((response.body as { data: unknown[] }).data).toEqual([]);
    }
  });

  it('cannot attach another workspace’s record to a tag by naming its id', async () => {
    const response = await tagAdd(adminA.token, contactB, ['Mine']);
    const result = dataOf<{ changed: number; skipped: { reason: string }[] }>(response, 200);
    expect(result.changed).toBe(0);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['not_found']);
    expect(await harness.fixtures.recordTagNames(tenantB, 'contact', contactB)).toEqual([
      'Rival secret',
    ]);
  });
});

describe('(b) a caller with own scope', () => {
  it('sees the tags of their own records, and a colleague’s record is a 404, tags and all', async () => {
    const mine = dataOf<{ tags: { name: string }[] }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts/${repContact}`,
        token: repA.token,
      }),
    );
    expect(mine.tags.map((tag) => tag.name)).toEqual(['Mine']);

    const theirs = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${colleagueContact}`,
      token: repA.token,
    });
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toContain('Theirs');
  });

  it('gets only their own rows from a list, and a tag filter cannot reach a colleague’s record', async () => {
    const tagTheirs = (await tagsFor(adminA.token)).find((tag) => tag.name === 'Theirs')!;
    const rows = async (filter?: string) => {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts${filter === undefined ? '' : `?filter=${encodeURIComponent(filter)}`}`,
        token: repA.token,
      });
      expect(response.status).toBe(200);
      return (response.body as { data: { id: string; tags: { name: string }[] }[] }).data;
    };

    const all = await rows();
    expect(all.map((row) => row.id)).toEqual([repContact]);
    expect(JSON.stringify(all)).not.toContain('Theirs');
    // A filter on a tag that only a colleague's record carries finds nothing for this caller,
    // so it cannot be used to learn that a colleague's record has it.
    expect(await rows(`tags:has_any:${tagTheirs.id}`)).toEqual([]);
    expect(await rows(`tags:has_none:${tagTheirs.id}`)).toHaveLength(1);
  });

  it('cannot see usage counts, rename or delete a tag: that is for whoever manages the workspace', async () => {
    const mine = (await tagsFor(repA.token)).find((tag) => tag.name === 'Mine')!;
    expect(
      (await request(harness, { method: 'GET', url: '/api/v1/tags/usage', token: repA.token }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(harness, {
          method: 'PATCH',
          url: `/api/v1/tags/${mine.id}`,
          token: repA.token,
          body: { name: 'Renamed', version: mine.version },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness, {
          method: 'DELETE',
          url: `/api/v1/tags/${mine.id}?version=${mine.version}`,
          token: repA.token,
        })
      ).status,
    ).toBe(403);
    expect((await tagsFor(adminA.token)).map((tag) => tag.name)).toContain('Mine');
  });
});

describe('(c) tags are not a field, and a tag list is for people who can read records', () => {
  it('does not show the workspace’s tag names to a role that can read no record kind', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/tags',
      token: nobodyA.token,
    });
    expect(response.status).toBe(403);
  });

  it('does not accept the tags pseudo-field in a place a field is read: no sorting', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?sort=-tags',
      token: adminA.token,
    });
    expect(response.status).toBe(422);
  });
});
