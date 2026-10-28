import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for record merge (ADR-0064), and the rules a
 * merge adds: it must never be a way to change or remove a record the caller could not change or remove
 * one at a time, to read a field they cannot read, or to find out what exists.
 *
 *   (a) tenant A cannot merge, preview or follow the pointers of tenant B
 *   (b) a caller with `own` scope can only merge their own records; a Manager, their team's; seeing a
 *       record is not the same as being allowed to merge it
 *   (c) a field hidden from, or read-only for, a role can neither be chosen nor read back from a merge
 *   (d) unauthenticated requests get 401
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let ownerA: { token: string; userId: string }; // own scope: read, update and delete
let ownerA2: { token: string; userId: string }; // a colleague, same role
let defaultRepA: { token: string; userId: string }; // the default Sales Rep: no delete grant
let readerA: { token: string; userId: string }; // reads all, changes and deletes only their own
let limitedA: { token: string; userId: string }; // contacts: all, but email hidden; no deal access
let managerA: { token: string; userId: string };
let teammateA: { token: string; userId: string };
let outsiderA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

let pipelineId: string;
let stageId: string;

const post = (token: string | undefined, body: unknown, headers?: Record<string, string>) =>
  request(harness, { method: 'POST', url: '/api/v1/merges', token, body, headers });

const get = (token: string, path: string) =>
  request(harness, { method: 'GET', url: `/api/v1/${path}`, token });

const errorCode = (response: { body: Record<string, unknown> }) =>
  (response.body['error'] as { code: string }).code;

const contactOf = (tenant: string, ownerId: string, lastName: string, extra = {}) =>
  harness.fixtures.createContact(tenant, { ownerId, lastName, ...extra });

async function pair(
  tenant: string,
  masterOwner: string,
  loserOwner: string,
  label: string,
  masterExtra: Record<string, unknown> = {},
  loserExtra: Record<string, unknown> = {},
) {
  const master = await contactOf(tenant, masterOwner, `${label} master`, masterExtra);
  const loser = await contactOf(tenant, loserOwner, `${label} loser`, loserExtra);
  return {
    master,
    loser,
    body: (extra: Record<string, unknown> = {}) => ({
      objectType: 'contact',
      masterId: master,
      masterVersion: 1,
      loserId: loser,
      loserVersion: 1,
      fields: {},
      ...extra,
    }),
  };
}

const alive = async (id: string) =>
  (await harness.fixtures.rowOf('contacts', id))?.['deleted_at'] === null;

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
  defaultRepA = await make(tenantA, rolesA.get('Sales Rep')!);
  managerA = await make(tenantA, rolesA.get('Manager')!);
  teammateA = await make(tenantA, rolesA.get('Sales Rep')!);
  outsiderA = await make(tenantA, rolesA.get('Sales Rep')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);
  await harness.fixtures.createTeam(tenantA, 'Merge team', [managerA.userId, teammateA.userId]);
  await harness.fixtures.createTeam(tenantA, 'Merge other team', [outsiderA.userId]);

  // A rep who may merge their own: the default Sales Rep cannot delete (pilot finding F11), and a merge
  // deletes the loser, so it needs the grant a delete does.
  const ownerRole = await harness.fixtures.createRole(tenantA, 'Own merger');
  for (const objectType of ['contact', 'account', 'deal', 'lead', 'activity'] as const) {
    await harness.fixtures.grant(tenantA, ownerRole, objectType, 'read', 'own');
  }
  for (const action of ['update', 'delete'] as const) {
    await harness.fixtures.grant(tenantA, ownerRole, 'contact', action, 'own');
    await harness.fixtures.grant(tenantA, ownerRole, 'account', action, 'own');
  }
  ownerA = await make(tenantA, ownerRole);
  ownerA2 = await make(tenantA, ownerRole);

  const readerRole = await harness.fixtures.createRole(tenantA, 'Reader merger');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'read', 'all');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'update', 'own');
  await harness.fixtures.grant(tenantA, readerRole, 'contact', 'delete', 'own');
  readerA = await make(tenantA, readerRole);

  const limitedRole = await harness.fixtures.createRole(tenantA, 'Limited merger');
  await harness.fixtures.grantAll(tenantA, limitedRole, 'contact', 'all');
  await harness.fixtures.setFieldPermission(tenantA, limitedRole, 'contact', 'email', 'hidden');
  await harness.fixtures.setFieldPermission(tenantA, limitedRole, 'contact', 'title', 'read');
  // Can open the history, to prove the history respects a hidden field too.
  await harness.fixtures.grant(tenantA, limitedRole, 'audit_log', 'read', 'all');
  limitedA = await make(tenantA, limitedRole);

  const pipeline = (await harness.fixtures.pipelinesFor(tenantA))[0]!;
  pipelineId = pipeline.id;
  stageId = pipeline.stages[0]!.id;
}, 240_000);

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects a merge, a preview and a duplicates lookup with no credentials, or a made-up token', async () => {
    const { body } = await pair(tenantA, adminA.userId, adminA.userId, 'anon');
    expect((await post(undefined, body())).status).toBe(401);
    expect((await post('not-a-real-session-token-but-long-enough', body())).status).toBe(401);
    expect((await post(undefined, body({ dryRun: true }))).status).toBe(401);
    const id = crypto.randomUUID();
    for (const kind of ['contacts', 'accounts']) {
      expect(
        (await request(harness, { method: 'GET', url: `/api/v1/${kind}/${id}/duplicates` })).status,
      ).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('does not merge, preview or learn anything about records of another workspace', async () => {
    const theirs = await pair(tenantB, adminB.userId, adminB.userId, 'rival');
    const ours = await contactOf(tenantA, adminA.userId, 'ours');

    for (const body of [
      { ...theirs.body() },
      { ...theirs.body(), dryRun: true },
      // One of ours and one of theirs, either way round.
      { ...theirs.body(), masterId: ours },
      { ...theirs.body(), loserId: ours },
    ]) {
      const response = await post(adminA.token, body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(404);
    }
    expect(await alive(theirs.master)).toBe(true);
    expect(await alive(theirs.loser)).toBe(true);
    expect(await alive(ours)).toBe(true);
    expect(await harness.fixtures.mergePointers(tenantB)).toEqual([]);

    // The same answer as for an id that never existed.
    const crossTenant = await post(adminA.token, theirs.body());
    const never = await post(adminA.token, {
      ...theirs.body(),
      masterId: crypto.randomUUID(),
      loserId: crypto.randomUUID(),
    });
    expect(never.status).toBe(404);
    expect(errorCode(never)).toBe(errorCode(crossTenant));
    expect((never.body['error'] as { message: string }).message).toBe(
      (crossTenant.body['error'] as { message: string }).message,
    );
  });

  it('does not answer another workspace’s merged-away id with a "merged into" pointer', async () => {
    const theirs = await pair(tenantB, adminB.userId, adminB.userId, 'rival merged');
    expect(
      (
        await post(adminB.token, {
          ...theirs.body(),
          masterVersion: 1,
          loserVersion: 1,
        })
      ).status,
    ).toBe(200);
    // Their own admin is told where it went; a stranger from another workspace is told nothing.
    expect((await get(adminB.token, `contacts/${theirs.loser}`)).status).toBe(410);
    expect((await get(adminA.token, `contacts/${theirs.loser}`)).status).toBe(404);
    expect(await harness.fixtures.mergePointers(tenantA)).toEqual([]);
  });
});

describe('(b) a caller with own scope', () => {
  it('merges two contacts they own, and an old id then answers them with the survivor', async () => {
    const { master, loser, body } = await pair(tenantA, ownerA.userId, ownerA.userId, 'own pair');
    const response = await post(ownerA.token, body());
    expect(response.status).toBe(200);
    expect(await alive(loser)).toBe(false);

    const old = await get(ownerA.token, `contacts/${loser}`);
    expect(old.status).toBe(410);
    expect(old.body['error']).toMatchObject({ details: [{ message: master }] });
  });

  it('cannot merge a colleague’s record as either side, and is told it was not found', async () => {
    const mine = await contactOf(tenantA, ownerA.userId, 'mine');
    const theirs = await contactOf(tenantA, ownerA2.userId, 'theirs');
    const base = {
      objectType: 'contact',
      masterVersion: 1,
      loserVersion: 1,
      fields: {},
    };
    const asLoser = await post(ownerA.token, { ...base, masterId: mine, loserId: theirs });
    const asMaster = await post(ownerA.token, { ...base, masterId: theirs, loserId: mine });
    const preview = await post(ownerA.token, {
      ...base,
      masterId: mine,
      loserId: theirs,
      dryRun: true,
    });
    for (const response of [asLoser, asMaster, preview]) {
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    }
    // The same words for a record that does not exist, so the id cannot be probed.
    const never = await post(ownerA.token, {
      ...base,
      masterId: mine,
      loserId: crypto.randomUUID(),
    });
    expect((never.body['error'] as { message: string }).message).toBe(
      (asLoser.body['error'] as { message: string }).message,
    );
    expect(await alive(mine)).toBe(true);
    expect(await alive(theirs)).toBe(true);
  });

  it('does not learn a colleague’s merged-away id: a merge by somebody else leaves a plain 404', async () => {
    const { loser, body } = await pair(tenantA, ownerA2.userId, ownerA2.userId, 'colleague pair');
    expect((await post(adminA.token, body())).status).toBe(200);
    // The survivor and the loser belong to a colleague: for this caller it is any record they cannot see.
    expect((await get(ownerA.token, `contacts/${loser}`)).status).toBe(404);
    // While the colleague is told where it went.
    expect((await get(ownerA2.token, `contacts/${loser}`)).status).toBe(410);
  });

  it('does not offer a list of duplicates to a role that cannot change contacts', async () => {
    const mine = await contactOf(tenantA, ownerA.userId, 'dup source');
    const read = await get(ownerA.token, `contacts/${mine}/duplicates`);
    expect(read.status).toBe(200);
    // A read-only role gets a refusal: the only use of the list is to merge.
    const readOnly = await harness.fixtures.createRole(tenantA, 'Reads only');
    await harness.fixtures.grant(tenantA, readOnly, 'contact', 'read', 'all');
    const viewer = await harness.fixtures.createUser(tenantA, readOnly);
    const token = await harness.signIn(viewer.userId, tenantA);
    expect((await get(token, `contacts/${mine}/duplicates`)).status).toBe(403);
  });

  it('is refused by the default Sales Rep, who has no delete grant, before anything is looked up', async () => {
    const { body, loser } = await pair(
      tenantA,
      defaultRepA.userId,
      defaultRepA.userId,
      'default rep',
    );
    const response = await post(defaultRepA.token, body());
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('FORBIDDEN');
    expect(await alive(loser)).toBe(true);
    // Not even to say whether an id exists.
    const strangerBody = { ...body(), loserId: crypto.randomUUID() };
    expect((await post(defaultRepA.token, strangerBody)).status).toBe(403);
  });

  it('sees a colleague’s record but is not allowed to merge it: 403, not 404, and nothing changes', async () => {
    const mine = await contactOf(tenantA, readerA.userId, 'reader mine');
    const theirs = await contactOf(tenantA, ownerA.userId, 'reader theirs');
    const base = { objectType: 'contact', masterVersion: 1, loserVersion: 1, fields: {} };

    // Merging their own into a colleague's: may not update the colleague's.
    const intoTheirs = await post(readerA.token, { ...base, masterId: theirs, loserId: mine });
    expect(intoTheirs.status).toBe(403);
    // Merging a colleague's into their own: may not delete the colleague's.
    const away = await post(readerA.token, { ...base, masterId: mine, loserId: theirs });
    expect(away.status).toBe(403);
    expect(await alive(mine)).toBe(true);
    expect(await alive(theirs)).toBe(true);
  });

  it('merges records whose deals belong to colleagues without being told, or showing, how many', async () => {
    const { master, loser, body } = await pair(
      tenantA,
      ownerA.userId,
      ownerA.userId,
      'hidden deals',
    );
    const colleagueDeal = await harness.fixtures.createDeal(tenantA, {
      ownerId: ownerA2.userId,
      name: 'Colleague deal',
      pipelineId,
      stageId,
      primaryContactId: loser,
    });

    const preview = dataOf<{ counts: { deals: number | null } }>(
      await post(ownerA.token, body({ dryRun: true })),
      200,
    );
    // The deal is a colleague's, outside this caller's scope: they are shown 0, not 1.
    expect(preview.counts.deals).toBe(0);

    expect((await post(ownerA.token, body())).status).toBe(200);
    // Every row moved, including the one they cannot see: nothing is left pointing at the merged-away record.
    expect((await harness.fixtures.dealRow(colleagueDeal))?.primary_contact_id).toBe(master);
  });
});

describe('a Manager holds team scope', () => {
  it('merges two contacts owned by teammates', async () => {
    const { loser, body } = await pair(tenantA, teammateA.userId, teammateA.userId, 'team pair');
    const response = await post(managerA.token, body());
    expect(response.status).toBe(200);
    expect(await alive(loser)).toBe(false);
  });

  it('cannot merge a teammate’s record with, or away into, one owned outside the team', async () => {
    const mine = await contactOf(tenantA, teammateA.userId, 'team member');
    const stranger = await contactOf(tenantA, outsiderA.userId, 'outside team');
    const base = { objectType: 'contact', masterVersion: 1, loserVersion: 1, fields: {} };
    for (const body of [
      { ...base, masterId: mine, loserId: stranger },
      { ...base, masterId: stranger, loserId: mine },
    ]) {
      expect((await post(managerA.token, body)).status).toBe(404);
    }
    expect(await alive(mine)).toBe(true);
    expect(await alive(stranger)).toBe(true);
  });
});

describe('(c) fields a role cannot read or write', () => {
  it('cannot choose a hidden field, or a read-only one, and the answer is the one for a field that does not exist', async () => {
    const { master, loser, body } = await pair(
      tenantA,
      limitedA.userId,
      limitedA.userId,
      'limited fields',
      { email: 'master-secret@acme.example', title: 'Manager' },
      { email: 'loser-secret@acme.example', title: 'Director' },
    );

    const hidden = await post(limitedA.token, body({ fields: { email: 'loser' } }));
    const readOnly = await post(limitedA.token, body({ fields: { title: 'loser' } }));
    const missing = await post(limitedA.token, body({ fields: { nosuchfield: 'loser' } }));
    for (const response of [hidden, readOnly, missing]) {
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe('FIELD_NOT_WRITABLE');
    }
    // Naming a hidden field with "master" is not a way to probe either: it is refused the same way.
    expect((await post(limitedA.token, body({ fields: { email: 'master' } }))).status).toBe(403);
    expect(await alive(loser)).toBe(true);
    expect((await harness.fixtures.rowOf('contacts', master))?.['email']).toBe(
      'master-secret@acme.example',
    );
  });

  it('keeps the hidden field out of the answer, the preview and the audit entry the caller can read', async () => {
    const { master, loser, body } = await pair(
      tenantA,
      limitedA.userId,
      limitedA.userId,
      'limited answer',
      { email: 'keep-master@acme.example' },
      { email: 'drop-loser@acme.example' },
    );

    const preview = await post(limitedA.token, body({ dryRun: true }));
    const merged = await post(limitedA.token, body());
    for (const response of [preview, merged]) {
      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('keep-master@acme.example');
      expect(text).not.toContain('drop-loser@acme.example');
      expect(
        (response.body['data'] as { record: Record<string, unknown> }).record,
      ).not.toHaveProperty('email');
    }
    expect((await harness.fixtures.rowOf('contacts', master))?.['email']).toBe(
      'keep-master@acme.example',
    );
    const view = await request(harness, {
      method: 'GET',
      url: `/api/v1/audit-logs?objectType=contact&recordId=${loser}`,
      token: limitedA.token,
    });
    expect(view.status).toBe(200);
    // The history holds the loser's e-mail for those who may read it; this reader may not.
    expect(JSON.stringify(view.body)).not.toContain('drop-loser@acme.example');
    expect(JSON.stringify(view.body)).toContain('merge');
  });

  it('does not count the kinds of record a role has no read access to', async () => {
    const { loser, body } = await pair(tenantA, limitedA.userId, limitedA.userId, 'no deals');
    await harness.fixtures.createDeal(tenantA, {
      ownerId: adminA.userId,
      name: 'Admin deal',
      pipelineId,
      stageId,
      primaryContactId: loser,
    });
    const preview = dataOf<{ counts: Record<string, number | null> }>(
      await post(limitedA.token, body({ dryRun: true })),
      200,
    );
    expect(preview.counts['deals']).toBeNull();
    expect(preview.counts['activities']).toBeNull();
    expect(preview.counts['notes']).toBeNull();
  });

  it('refuses unknown keys in the request, as every other write does', async () => {
    const { body } = await pair(tenantA, adminA.userId, adminA.userId, 'strict');
    expect((await post(adminA.token, body({ tenantId: tenantB }))).status).toBe(422);
    expect((await post(adminA.token, body({ ownerId: adminA.userId }))).status).toBe(422);
    expect((await post(adminA.token, body({ fields: { email: 'both' } }))).status).toBe(422);
    expect((await post(adminA.token, body({ masterVersion: 0 }))).status).toBe(422);
  });
});
