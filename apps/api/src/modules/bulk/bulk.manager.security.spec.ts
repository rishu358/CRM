import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The default Manager through the bulk routes (pilot findings F2 and F3, ADR-0058).
 *
 * The pilot did not exercise bulk actions. A Manager holds `team` scope, so a bulk assign must hand
 * records to somebody on the team and only touch records inside it, a bulk delete must reach the team's
 * records and no others, and what a bulk delete removes must be restorable by the same Manager.
 */
let harness: ApiHarness;
let tenantId: string;
let manager: { token: string; userId: string };
let teammate: { token: string; userId: string };
let outsider: { token: string; userId: string };

async function user(roleId: string) {
  const created = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Bulk Manager' })).tenantId;
  const roles = await harness.provision(tenantId);
  manager = await user(roles.get('Manager')!);
  teammate = await user(roles.get('Sales Rep')!);
  outsider = await user(roles.get('Sales Rep')!);
  await harness.fixtures.createTeam(tenantId, 'Bulk team', [manager.userId, teammate.userId]);
  await harness.fixtures.createTeam(tenantId, 'Bulk other team', [outsider.userId]);
}, 240_000);

afterAll(async () => {
  await harness.close();
});

const bulk = (token: string, body: Record<string, unknown>) =>
  request(harness, { method: 'POST', url: '/api/v1/bulk-actions', token, body });

const result = (response: { body: Record<string, unknown> }) =>
  response.body['data'] as {
    changedIds: string[];
    skipped: { id: string; reason: string }[];
  };

const contact = (ownerId: string, lastName: string) =>
  harness.fixtures.createContact(tenantId, { ownerId, lastName });

describe('bulk assign by a Manager (F2)', () => {
  it('hands teammates’ contacts to the Manager, and leaves a stranger’s alone', async () => {
    const mine = await contact(teammate.userId, 'Team A');
    const mine2 = await contact(teammate.userId, 'Team B');
    const theirs = await contact(outsider.userId, 'Outside');

    const response = await bulk(manager.token, {
      objectType: 'contact',
      action: 'assign',
      ownerId: manager.userId,
      target: { kind: 'ids', ids: [mine, mine2, theirs] },
    });
    expect(response.status).toBe(200);
    expect(new Set(result(response).changedIds)).toEqual(new Set([mine, mine2]));
    // Outside the Manager's reach: reported as not found, the same as an id that does not exist.
    expect(result(response).skipped).toEqual([{ id: theirs, reason: 'not_found' }]);
  });

  it('refuses an owner outside the team, as it refuses one who does not exist', async () => {
    const id = await contact(teammate.userId, 'Cannot leave team');
    const toOutsider = await bulk(manager.token, {
      objectType: 'contact',
      action: 'assign',
      ownerId: outsider.userId,
      target: { kind: 'ids', ids: [id] },
    });
    const toNobody = await bulk(manager.token, {
      objectType: 'contact',
      action: 'assign',
      ownerId: crypto.randomUUID(),
      target: { kind: 'ids', ids: [id] },
    });
    expect(toOutsider.status).toBe(422);
    expect(toNobody.status).toBe(422);
    expect(JSON.stringify(toOutsider.body['error'])).toBe(
      JSON.stringify({
        ...(toNobody.body['error'] as Record<string, unknown>),
        requestId: (toOutsider.body['error'] as Record<string, unknown>)['requestId'],
      }),
    );
  });

  it('does not let a Sales Rep (own scope) assign at all', async () => {
    const id = await contact(teammate.userId, 'Rep cannot');
    const response = await bulk(teammate.token, {
      objectType: 'contact',
      action: 'assign',
      ownerId: manager.userId,
      target: { kind: 'ids', ids: [id] },
    });
    expect([403, 422]).toContain(response.status);
  });
});

describe('bulk delete by a Manager, and getting it back (F3)', () => {
  it('deletes the team’s contacts, skips a stranger’s, and the Manager can restore what was deleted', async () => {
    const mine = await contact(teammate.userId, 'Bulk deleted');
    const theirs = await contact(outsider.userId, 'Bulk untouched');

    const response = await bulk(manager.token, {
      objectType: 'contact',
      action: 'delete',
      target: { kind: 'ids', ids: [mine, theirs] },
    });
    expect(response.status).toBe(200);
    expect(result(response).changedIds).toEqual([mine]);
    expect(result(response).skipped).toEqual([{ id: theirs, reason: 'not_found' }]);

    const bin = await request(harness, {
      method: 'GET',
      url: '/api/v1/recycle-bin?objectType=contact&limit=100',
      token: manager.token,
    });
    const entry = (bin.body['data'] as { id: string; version: number }[]).find(
      (row) => row.id === mine,
    );
    expect(entry).toBeDefined();
    expect((bin.body['data'] as { id: string }[]).map((row) => row.id)).not.toContain(theirs);

    const restored = await request(harness, {
      method: 'POST',
      url: `/api/v1/recycle-bin/contact/${mine}/restore`,
      token: manager.token,
      body: { version: entry!.version },
    });
    expect(restored.status).toBe(200);
  });
});
