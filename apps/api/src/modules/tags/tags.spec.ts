import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * What tags do (ADR-0063): they ride on every record and every list row, a list filters by them,
 * and an administrator renames, recolours and deletes them. Who may do what, and the walls
 * between workspaces, are in `tags.security.spec.ts`.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

interface Tag {
  id: string;
  name: string;
  color: string | null;
  version: number;
}

const tagAdd = (objectType: string, id: string, tags: string[]) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/bulk-actions',
    token: admin.token,
    body: { objectType, action: 'tag_add', tags, target: { kind: 'ids', ids: [id] } },
  });

const listTags = async () =>
  dataOf<Tag[]>(await request(harness, { method: 'GET', url: '/api/v1/tags', token: admin.token }));

const tagByName = async (name: string): Promise<Tag> => {
  const found = (await listTags()).find((tag) => tag.name === name);
  if (found === undefined) throw new Error(`The test expected a tag named ${name}`);
  return found;
};

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const roles = await harness.provision(tenantId);
  const adminUser = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: adminUser.userId, token: await harness.signIn(adminUser.userId, tenantId) };
});

afterAll(async () => {
  await harness.close();
});

describe('tags on records', () => {
  it('shows a record its tags, on the record and on its row in the list, for all four kinds', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Chipped',
    });
    const account = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Chipped Traders',
    });
    const lead = await harness.fixtures.createLead(tenantId, {
      ownerId: admin.userId,
      lastName: 'Chipped',
    });
    await tagAdd('contact', contact, ['Wholesale', 'VIP']);
    await tagAdd('account', account, ['Wholesale']);
    await tagAdd('lead', lead, ['Hot']);

    const one = dataOf<{ tags: { name: string; color: string | null }[] }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts/${contact}`,
        token: admin.token,
      }),
    );
    // By name, ignoring case, so the chips do not jump around between visits.
    expect(one.tags.map((tag) => tag.name)).toEqual(['VIP', 'Wholesale']);

    const listed = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?q=Chipped',
      token: admin.token,
    });
    const rows = (listed.body as { data: { id: string; tags: { name: string }[] }[] }).data;
    expect(rows.find((row) => row.id === contact)?.tags.map((tag) => tag.name)).toEqual([
      'VIP',
      'Wholesale',
    ]);

    const accountOne = dataOf<{ tags: { name: string }[] }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts/${account}`,
        token: admin.token,
      }),
    );
    expect(accountOne.tags.map((tag) => tag.name)).toEqual(['Wholesale']);
    const leadOne = dataOf<{ tags: { name: string }[] }>(
      await request(harness, { method: 'GET', url: `/api/v1/leads/${lead}`, token: admin.token }),
    );
    expect(leadOne.tags.map((tag) => tag.name)).toEqual(['Hot']);
  });

  it('shows an empty list for a record with no tags, not a missing field', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Plain',
    });
    const one = dataOf<{ tags: unknown[] }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts/${contact}`,
        token: admin.token,
      }),
    );
    expect(one.tags).toEqual([]);
  });

  it('keeps showing the tags after the record is edited', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Edited',
    });
    await tagAdd('contact', contact, ['Keep']);
    const before = dataOf<{ version: number }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts/${contact}`,
        token: admin.token,
      }),
    );
    const updated = dataOf<{ tags: { name: string }[]; version: number }>(
      await request(harness, {
        method: 'PATCH',
        url: `/api/v1/contacts/${contact}`,
        token: admin.token,
        body: { title: 'Owner', version: before.version },
      }),
    );
    expect(updated.tags.map((tag) => tag.name)).toEqual(['Keep']);
    // Tagging is a relation, not a field of the record: it did not move the record's version.
    expect(updated.version).toBe(before.version + 1);
  });
});

describe('filtering a list by tag', () => {
  it('finds records that have any of the tags, and records that have none of them', async () => {
    const have = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'FilterHas',
    });
    const other = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'FilterOther',
    });
    const bare = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'FilterBare',
    });
    await tagAdd('contact', have, ['F-red']);
    await tagAdd('contact', other, ['F-blue']);
    const red = await tagByName('F-red');
    const blue = await tagByName('F-blue');

    const idsFor = async (filter: string) => {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts?q=Filter&filter=${encodeURIComponent(filter)}`,
        token: admin.token,
      });
      expect(response.status, filter).toBe(200);
      return (response.body as { data: { id: string }[] }).data.map((row) => row.id).sort();
    };

    expect(await idsFor(`tags:has_any:${red.id}`)).toEqual([have]);
    expect(await idsFor(`tags:has_any:${red.id},${blue.id}`)).toEqual([have, other].sort());
    expect(await idsFor(`tags:has_none:${red.id},${blue.id}`)).toEqual([bare]);
    expect(await idsFor(`tags:has_none:${red.id}`)).toEqual([other, bare].sort());
  });

  it('treats a tag id that names nothing as a tag nobody has', async () => {
    const nothing = crypto.randomUUID();
    const any = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts?filter=${encodeURIComponent(`tags:has_any:${nothing}`)}`,
      token: admin.token,
    });
    expect((any.body as { data: unknown[] }).data).toEqual([]);
  });

  it('refuses a malformed tag filter and the tag operators on any other field', async () => {
    const bad = [
      'tags:has_any:',
      'tags:has_any:not-an-id',
      `tags:has_any:${crypto.randomUUID()}' or 1=1 --`,
      `tags:eq:${crypto.randomUUID()}`,
      'tags:contains:vip',
      `last_name:has_any:${crypto.randomUUID()}`,
      `tags:has_any:${Array.from({ length: 7 }, () => crypto.randomUUID()).join(',')}`,
    ];
    for (const filter of bad) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts?filter=${encodeURIComponent(filter)}`,
        token: admin.token,
      });
      expect(response.status, filter).toBe(422);
    }
  });

  it('does not let a list be sorted by tags', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?sort=tags',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('works through a saved view and an export too', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'ViewTagged',
    });
    await tagAdd('contact', contact, ['V-tag']);
    const tag = await tagByName('V-tag');

    const view = await request(harness, {
      method: 'POST',
      url: '/api/v1/saved-views',
      token: admin.token,
      body: {
        objectType: 'contact',
        name: 'Tagged V',
        filters: { conditions: [{ field: 'tags', operator: 'has_any', value: tag.id }] },
      },
    });
    expect(view.status).toBe(201);

    const refused = await request(harness, {
      method: 'POST',
      url: '/api/v1/saved-views',
      token: admin.token,
      body: {
        objectType: 'contact',
        name: 'Bad tag view',
        filters: { conditions: [{ field: 'tags', operator: 'eq', value: tag.id }] },
      },
    });
    expect(refused.status).toBe(422);

    // Bulk by filter reaches exactly the tagged records.
    const dry = await request(harness, {
      method: 'POST',
      url: '/api/v1/bulk-actions',
      token: admin.token,
      body: {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['Second'],
        dryRun: true,
        target: {
          kind: 'filter',
          filter: { conditions: [{ field: 'tags', operator: 'has_any', value: tag.id }] },
        },
      },
    });
    const result = dataOf<{ changedIds: string[] }>(dry, 200);
    expect(result.changedIds).toEqual([contact]);
  });
});

describe('managing tags', () => {
  it('lists every tag with how many live records carry it, per kind', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Counted',
    });
    const gone = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'CountedGone',
    });
    await tagAdd('contact', contact, ['Counted']);
    await tagAdd('contact', gone, ['Counted']);
    // A deleted record is not counted: it is in the Recycle Bin, not on a list.
    await harness.fixtures.softDeleteRecord('contacts', gone);

    const usage = dataOf<
      { name: string; records: { contact: number; account: number; lead: number; deal: number } }[]
    >(await request(harness, { method: 'GET', url: '/api/v1/tags/usage', token: admin.token }));
    expect(usage.find((row) => row.name === 'Counted')?.records).toEqual({
      contact: 1,
      account: 0,
      lead: 0,
      deal: 0,
    });
  });

  it('renames and recolours a tag, moves its version, audits it and announces it', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Renamed',
    });
    await tagAdd('contact', contact, ['Old name']);
    const tag = await tagByName('Old name');

    const patched = dataOf<Tag>(
      await request(harness, {
        method: 'PATCH',
        url: `/api/v1/tags/${tag.id}`,
        token: admin.token,
        body: { name: 'New name', color: 'teal', version: tag.version },
      }),
    );
    expect(patched).toMatchObject({ name: 'New name', color: 'teal', version: tag.version + 1 });

    const one = dataOf<{ tags: { name: string; color: string | null }[] }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts/${contact}`,
        token: admin.token,
      }),
    );
    expect(one.tags).toEqual([expect.objectContaining({ name: 'New name', color: 'teal' })]);

    const audit = await harness.fixtures.auditEntries(tenantId, 'tag');
    expect(audit.some((entry) => entry.recordId === tag.id && entry.action === 'update')).toBe(
      true,
    );
    expect(await harness.fixtures.outboxEventTypes(tenantId)).toContain('tag.updated.v1');
  });

  it('refuses a stale version, a name another tag has (whatever the case) and a colour outside the list', async () => {
    await tagAdd(
      'contact',
      await harness.fixtures.createContact(tenantId, { ownerId: admin.userId, lastName: 'Clash' }),
      ['Clash one', 'Clash two'],
    );
    const one = await tagByName('Clash one');

    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/tags/${one.id}`,
      token: admin.token,
      body: { color: 'red', version: one.version + 5 },
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');

    const taken = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/tags/${one.id}`,
      token: admin.token,
      body: { name: 'CLASH TWO', version: one.version },
    });
    expect(taken.status).toBe(409);

    for (const body of [
      { color: 'not-a-colour', version: one.version },
      { color: 'red; background:url(x)', version: one.version },
      { name: '', version: one.version },
      { version: one.version },
      { name: 'Fine', version: one.version, extra: true },
    ]) {
      const response = await request(harness, {
        method: 'PATCH',
        url: `/api/v1/tags/${one.id}`,
        token: admin.token,
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }

    // Changing only the letter case of its own name is not a clash with itself.
    const recased = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/tags/${one.id}`,
      token: admin.token,
      body: { name: 'clash ONE', version: one.version },
    });
    expect(recased.status).toBe(200);
  });

  it('deletes a tag from every record, with one audit entry and one event for the tag', async () => {
    const a = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Doomed A',
    });
    const b = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Doomed B',
    });
    await tagAdd('contact', a, ['Doomed']);
    await tagAdd('contact', b, ['Doomed', 'Survivor']);
    const tag = await tagByName('Doomed');
    const auditBefore = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;

    const stale = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/tags/${tag.id}?version=${tag.version + 3}`,
      token: admin.token,
    });
    expect(stale.status).toBe(409);

    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/tags/${tag.id}?version=${tag.version}`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', a)).toEqual([]);
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', b)).toEqual(['Survivor']);
    expect((await listTags()).map((row) => row.name)).not.toContain('Doomed');

    const tagAudit = (await harness.fixtures.auditEntries(tenantId, 'tag')).filter(
      (entry) => entry.recordId === tag.id && entry.action === 'delete',
    );
    expect(tagAudit).toHaveLength(1);
    // One entry for the tag, not one per record.
    expect((await harness.fixtures.auditEntries(tenantId, 'contact')).length).toBe(auditBefore);

    const gone = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/tags/${tag.id}?version=${tag.version}`,
      token: admin.token,
    });
    expect(gone.status).toBe(404);
  });
});
