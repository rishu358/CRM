import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot list/read/update/delete tenant B records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses and rejected on write
 *   (d) unauthenticated requests get 401
 *
 * Plus what is specific to deals: every column that takes an id from the
 * client and stores it (`stageId`, `pipelineId`, `accountId`,
 * `primaryContactId`, `contacts`) is the way a reference could be planted
 * across a tenant boundary; and the board's totals are a sum, which is a way
 * to read a field that was hidden or a record that was out of scope.
 *
 * They go through the real HTTP stack — the same guards, pipes, filter and
 * database roles as production — because every one of those layers is part of
 * what is being asserted.
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
let readOnlyA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

let pipelineA: string;
let stagesA: Record<string, string>;
let pipelineB: string;
let stagesB: Record<string, string>;

let adminDealA: string;
let repDealA: string;
let dealB: string;
let accountB: string;
let contactB: string;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Holdings' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Holdings' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  const admin = await harness.fixtures.createUser(tenantA, rolesA.get('Admin')!);
  adminA = { userId: admin.userId, token: await harness.signIn(admin.userId, tenantA) };
  const rep = await harness.fixtures.createUser(tenantA, rolesA.get('Sales Rep')!);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };
  const otherRep = await harness.fixtures.createUser(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = { userId: otherRep.userId, token: await harness.signIn(otherRep.userId, tenantA) };
  const readOnly = await harness.fixtures.createUser(tenantA, rolesA.get('Read-only')!);
  readOnlyA = { userId: readOnly.userId, token: await harness.signIn(readOnly.userId, tenantA) };
  const bAdmin = await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!);
  adminB = { userId: bAdmin.userId, token: await harness.signIn(bAdmin.userId, tenantB) };

  const mainA = (await harness.fixtures.pipelinesFor(tenantA)).find((p) => p.isDefault)!;
  pipelineA = mainA.id;
  stagesA = Object.fromEntries(mainA.stages.map((stage) => [stage.name, stage.id]));
  const mainB = (await harness.fixtures.pipelinesFor(tenantB)).find((p) => p.isDefault)!;
  pipelineB = mainB.id;
  stagesB = Object.fromEntries(mainB.stages.map((stage) => [stage.name, stage.id]));

  adminDealA = await harness.fixtures.createDeal(tenantA, {
    pipelineId: pipelineA,
    stageId: stagesA['New']!,
    ownerId: adminA.userId,
    name: 'Mehta Exports order',
    amountMinor: 500_000n,
    currency: 'INR',
  });
  repDealA = await harness.fixtures.createDeal(tenantA, {
    pipelineId: pipelineA,
    stageId: stagesA['New']!,
    ownerId: repA.userId,
    name: 'Sharma Textiles order',
    amountMinor: 120_000n,
    currency: 'INR',
  });
  dealB = await harness.fixtures.createDeal(tenantB, {
    pipelineId: pipelineB,
    stageId: stagesB['New']!,
    ownerId: adminB.userId,
    name: 'Rival Traders order',
    amountMinor: 999_999n,
    currency: 'INR',
  });
  accountB = await harness.fixtures.createAccount(tenantB, { ownerId: adminB.userId });
  contactB = await harness.fixtures.createContact(tenantB, { ownerId: adminB.userId });
});

afterAll(async () => {
  await harness.close();
});

function withoutRequestId(body: Record<string, unknown>): unknown {
  const { requestId: _requestId, ...rest } = body['error'] as Record<string, unknown>;
  return rest;
}

describe('(d) unauthenticated requests get 401', () => {
  it('rejects a list, a board and the pipelines with no credentials', async () => {
    for (const url of ['/api/v1/deals', '/api/v1/deals/board', '/api/v1/pipelines']) {
      const response = await request(harness, { method: 'GET', url });
      expect(response.status, url).toBe(401);
    }
  });

  it('rejects a read, a create, an update and a delete', async () => {
    const calls = [
      { method: 'GET', url: `/api/v1/deals/${adminDealA}` },
      { method: 'POST', url: '/api/v1/deals', body: { name: 'Intruder deal' } },
      { method: 'PATCH', url: `/api/v1/deals/${adminDealA}`, body: { version: 1 } },
      { method: 'DELETE', url: `/api/v1/deals/${adminDealA}?version=1` },
    ] as const;

    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });

  it('returns the error envelope with a request id, and no stack trace', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/deals' });
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(typeof error['requestId']).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:/);
  });
});

describe('(a) tenant A cannot reach tenant B records', () => {
  it('lists only its own tenant records', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?limit=100',
      token: adminA.token,
    });
    expect(response.status).toBe(200);
    const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(adminDealA);
    expect(ids).toContain(repDealA);
    expect(ids).not.toContain(dealB);
  });

  it('returns 404 for another tenant record, byte-identical to one that never existed', async () => {
    const foreign = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${dealB}`,
      token: adminA.token,
    });
    const absent = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals/01a1443a-0000-7000-8000-000000000000',
      token: adminA.token,
    });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(absent.body));
  });

  it('cannot update or delete another tenant record', async () => {
    const update = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${dealB}`,
      token: adminA.token,
      body: { name: 'Hacked', stageId: stagesA['Won'], version: 1 },
    });
    expect(update.status).toBe(404);

    const remove = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${dealB}?version=1`,
      token: adminA.token,
    });
    expect(remove.status).toBe(404);

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${dealB}`,
      token: adminB.token,
    });
    expect(check.body['data']).toMatchObject({ name: 'Rival Traders order', version: 1 });
  });

  it('cannot switch tenant with a header for a tenant it does not belong to', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a created deal name another tenant', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: adminA.token,
      body: { name: 'Smuggled', tenantId: tenantB },
    });
    expect(response.status).toBe(422);
  });

  it('cannot plant another tenant stage or pipeline on a deal, on create or on update', async () => {
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: adminA.token,
      body: { name: 'Foreign stage', stageId: stagesB['New'] },
    });
    expect(created.status).toBe(422);

    const foreignPipeline = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: adminA.token,
      body: { name: 'Foreign pipeline', pipelineId: pipelineB },
    });
    expect(foreignPipeline.status).toBe(422);

    // The one a drag reaches: a PATCH with a stage id from somewhere else.
    const moved = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${adminDealA}`,
      token: adminA.token,
      body: { stageId: stagesB['Won'], version: 1 },
    });
    expect(moved.status).toBe(422);

    const switched = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${adminDealA}`,
      token: adminA.token,
      body: { pipelineId: pipelineB, stageId: stagesB['New'], version: 1 },
    });
    expect(switched.status).toBe(422);
  });

  it('says the same about a foreign stage and one that does not exist', async () => {
    const send = (stageId: string) =>
      request(harness, {
        method: 'POST',
        url: '/api/v1/deals',
        token: adminA.token,
        body: { name: 'Probe', stageId },
      });
    const foreign = await send(stagesB['New']!);
    const missing = await send('01a1443a-0000-7000-8000-000000000000');
    // Otherwise a stage id becomes an existence oracle for other companies'
    // pipeline configuration.
    expect(foreign.status).toBe(missing.status);
    expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(missing.body));
  });

  it('cannot plant another tenant account or contact on a deal', async () => {
    for (const body of [
      { name: 'x', accountId: accountB },
      { name: 'x', primaryContactId: contactB },
      { name: 'x', contacts: [{ contactId: contactB }] },
    ]) {
      const created = await request(harness, {
        method: 'POST',
        url: '/api/v1/deals',
        token: adminA.token,
        body,
      });
      expect(created.status, JSON.stringify(body)).toBe(422);

      const updated = await request(harness, {
        method: 'PATCH',
        url: `/api/v1/deals/${adminDealA}`,
        token: adminA.token,
        body: { ...body, version: 1 },
      });
      expect(updated.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('says the same about a foreign account and a nonexistent one', async () => {
    const send = (accountId: string) =>
      request(harness, {
        method: 'POST',
        url: '/api/v1/deals',
        token: adminA.token,
        body: { name: 'Probe', accountId },
      });
    const foreign = await send(accountB);
    const missing = await send('01a1443a-0000-7000-8000-000000000000');
    expect(foreign.status).toBe(missing.status);
    expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(missing.body));
  });

  it('cannot read another tenant board, and sees none of its deals on its own', async () => {
    const foreignBoard = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/board?pipelineId=${pipelineB}`,
      token: adminA.token,
    });
    expect(foreignBoard.status).toBe(404);

    const own = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals/board',
      token: adminA.token,
    });
    const columns = (own.body['data'] as { columns: { count: number }[] }).columns;
    // Two deals in tenant A at this point; tenant B's is not among them.
    expect(columns.reduce((total, column) => total + column.count, 0)).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(own.body)).not.toContain('999999');
  });

  it('shows only its own pipelines', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/pipelines',
      token: adminA.token,
    });
    const ids = (response.body['data'] as { id: string }[]).map((pipeline) => pipeline.id);
    expect(ids).toContain(pipelineA);
    expect(ids).not.toContain(pipelineB);
  });
});

describe('(b) a user with own scope cannot see other people records', () => {
  it('lists only the deals the rep owns', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?limit=100',
      token: repA.token,
    });
    const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(repDealA);
    expect(ids).not.toContain(adminDealA);
  });

  it('keeps the scope on every page, including a nullable sort column', async () => {
    // The keyset predicate contains an `or`; an unbracketed one detaches the
    // scope filter and hands this rep the whole tenant from page two onward.
    for (let index = 0; index < 8; index += 1) {
      await harness.fixtures.createDeal(tenantA, {
        pipelineId: pipelineA,
        stageId: stagesA['New']!,
        ownerId: adminA.userId,
        name: `Admin owned ${index}`,
      });
      await harness.fixtures.createDeal(tenantA, {
        pipelineId: pipelineA,
        stageId: stagesA['New']!,
        ownerId: repA.userId,
        name: `Rep owned ${index}`,
      });
    }

    for (const sort of ['amount', '-amount', 'expected_close_date', '-closed_at']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query = new URLSearchParams({ limit: '3', sort });
        if (cursor !== null) query.set('cursor', cursor);
        const response = await request(harness, {
          method: 'GET',
          url: `/api/v1/deals?${query.toString()}`,
          token: repA.token,
        });
        expect(response.status, sort).toBe(200);
        for (const row of response.body['data'] as { id: string; ownerId?: string }[]) {
          seen.push(row.id);
          expect(row.ownerId, `${sort}: a deal owned by someone else`).toBe(repA.userId);
        }
        cursor = (response.body['meta'] as { nextCursor: string | null }).nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 30);

      expect(cursor, `${sort}: paging never ended`).toBeNull();
      expect(new Set(seen).size, `${sort}: a row came back twice`).toBe(seen.length);
    }
  });

  it('returns 404 when the rep reads, moves or deletes a colleague deal by id', async () => {
    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${adminDealA}`,
      token: repA.token,
    });
    expect(read.status).toBe(404);

    // A drag of somebody else's card.
    const moved = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${adminDealA}`,
      token: repA.token,
      body: { stageId: stagesA['Won'], version: 1 },
    });
    expect(moved.status).toBe(404);

    const row = await harness.fixtures.dealRow(adminDealA);
    expect(row?.stage_id).toBe(stagesA['New']);
  });

  it('refuses the rep deleting anything: Sales Rep has no delete grant', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${repDealA}?version=1`,
      token: repA.token,
    });
    expect(response.status).toBe(403);
  });

  it('keeps a colleague deals out of the board totals and counts', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals/board',
      token: otherRepA.token,
    });
    expect(response.status).toBe(200);
    // This rep owns nothing: every column is empty, whatever the tenant holds.
    const columns = (response.body['data'] as { columns: { count: number; total: unknown }[] })
      .columns;
    expect(columns.every((column) => column.count === 0)).toBe(true);

    const own = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals/board',
      token: repA.token,
    });
    const ownColumns = (own.body['data'] as { columns: { stageId: string; count: number }[] })
      .columns;
    const total = ownColumns.reduce((sum, column) => sum + column.count, 0);
    // Exactly the rep's own deals, not the tenant's.
    const mine = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?limit=100',
      token: repA.token,
    });
    expect(total).toBe((mine.body['data'] as unknown[]).length);
  });

  it('does not let a rep assign a deal to someone else', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: repA.token,
      body: { name: 'Handover', ownerId: otherRepA.userId },
    });
    expect(response.status).toBe(422);
  });

  it('assigns a rep own new deals to themselves', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: repA.token,
      body: { name: 'Patel Metals' },
    });
    expect(response.status).toBe(201);
    expect((response.body['data'] as Record<string, unknown>)['ownerId']).toBe(repA.userId);
  });

  it('lets a read-only user read and refuses every write', async () => {
    const read = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?limit=100',
      token: readOnlyA.token,
    });
    expect(read.status).toBe(200);

    const write = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${adminDealA}`,
      token: readOnlyA.token,
      body: { stageId: stagesA['Won'], version: 1 },
    });
    expect(write.status).toBe(403);
    const create = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: readOnlyA.token,
      body: { name: 'x' },
    });
    expect(create.status).toBe(403);
  });
});

describe('(c) hidden fields are absent from responses and rejected on write', () => {
  let hiddenRepToken: string;
  let lockedStageRepToken: string;
  let ownedDeal: string;

  beforeAll(async () => {
    // One role that cannot see the amount at all, and one that can read the
    // stage but not move it. Both are narrowings of a role that could
    // otherwise read and write everything.
    const hiddenRole = await harness.fixtures.createRole(tenantA, 'Rep without amounts');
    await harness.fixtures.grantAll(tenantA, hiddenRole, 'deal', 'all');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'deal', 'amount', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'deal', 'lost_reason', 'hidden');

    const lockedRole = await harness.fixtures.createRole(tenantA, 'Rep with locked stage');
    await harness.fixtures.grantAll(tenantA, lockedRole, 'deal', 'all');
    await harness.fixtures.setFieldPermission(tenantA, lockedRole, 'deal', 'stage_id', 'read');

    const hiddenUser = await harness.fixtures.createUser(tenantA, hiddenRole);
    hiddenRepToken = await harness.signIn(hiddenUser.userId, tenantA);
    const lockedUser = await harness.fixtures.createUser(tenantA, lockedRole);
    lockedStageRepToken = await harness.signIn(lockedUser.userId, tenantA);

    ownedDeal = await harness.fixtures.createDeal(tenantA, {
      pipelineId: pipelineA,
      stageId: stagesA['Lost']!,
      ownerId: hiddenUser.userId,
      name: 'Iyer Jewellers order',
      amountMinor: 770_000_123n,
      currency: 'USD',
      probability: 0,
      closedAt: new Date(),
      lostReason: 'Confidential reason: competitor undercut us',
    });
  });

  it('omits the hidden field from a single-record response', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${ownedDeal}`,
      token: hiddenRepToken,
    });
    expect(response.status).toBe(200);
    const deal = response.body['data'] as Record<string, unknown>;
    // Absent, not null: a null would still confirm the field exists and is set.
    expect('amount' in deal).toBe(false);
    expect('lostReason' in deal).toBe(false);
    expect(deal['name']).toBe('Iyer Jewellers order');
  });

  it('omits the hidden field from every row of a list', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?limit=100',
      token: hiddenRepToken,
    });
    const rows = response.body['data'] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect('amount' in row).toBe(false);
      expect('lostReason' in row).toBe(false);
    }
  });

  it('never leaks the hidden amount, its currency or the reason anywhere in the payload', async () => {
    for (const url of [`/api/v1/deals/${ownedDeal}`, '/api/v1/deals?limit=100']) {
      const response = await request(harness, { method: 'GET', url, token: hiddenRepToken });
      const body = JSON.stringify(response.body);
      expect(body, url).not.toContain('770000123');
      expect(body, url).not.toContain('USD');
      expect(body, url).not.toContain('Confidential reason');
    }
  });

  it('gives no board totals to a caller who cannot read the amount, only counts', async () => {
    // A column total is a sum of amounts: hiding the field has to hide what
    // can be computed from it, or the board is a side channel around the rule.
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals/board',
      token: hiddenRepToken,
    });
    expect(response.status).toBe(200);
    const columns = (
      response.body['data'] as {
        columns: { count: number; total: unknown; unconverted: unknown[] }[];
      }
    ).columns;
    for (const column of columns) {
      expect(column.total).toBeNull();
      expect(column.unconverted).toEqual([]);
    }
    expect(columns.reduce((sum, column) => sum + column.count, 0)).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain('770000123');
  });

  it('does not let a hidden field be sorted or filtered on, which would order by its value', async () => {
    for (const query of [
      'sort=amount',
      'sort=-lost_reason',
      'filter=amount:gt:700000000',
      'filter=lost_reason:starts_with:Conf',
    ]) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/deals?${query}`,
        token: hiddenRepToken,
      });
      expect(response.status, query).toBe(422);
    }
  });

  it('does not offer currency as a way round the amount permission', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?filter=currency:eq:USD',
      token: hiddenRepToken,
    });
    expect(response.status).toBe(422);
  });

  it('rejects a write to a hidden field instead of dropping it, on update and create', async () => {
    const update = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${ownedDeal}`,
      token: hiddenRepToken,
      body: { amount: { amountMinor: '1', currency: 'INR' }, version: 1 },
    });
    expect(update.status).toBe(403);
    expect((update.body['error'] as Record<string, unknown>)['code']).toBe('FIELD_NOT_WRITABLE');

    const create = await request(harness, {
      method: 'POST',
      url: '/api/v1/deals',
      token: hiddenRepToken,
      body: { name: 'Sneaky', amount: { amountMinor: '1', currency: 'INR' } },
    });
    expect(create.status).toBe(403);

    // And the stored value is untouched.
    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${ownedDeal}`,
      token: adminA.token,
    });
    expect((check.body['data'] as Record<string, unknown>)['amount']).toEqual({
      amountMinor: '770000123',
      currency: 'USD',
    });
  });

  it('refuses a move by a caller who can read the stage but not write it', async () => {
    // A drag is a write to `stageId`, so a field permission on it applies.
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/deals/${adminDealA}`,
      token: lockedStageRepToken,
      body: { stageId: stagesA['Qualified'], version: 1 },
    });
    expect(response.status).toBe(403);
    expect((await harness.fixtures.dealRow(adminDealA))?.stage_id).toBe(stagesA['New']);

    // Still readable.
    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${adminDealA}`,
      token: lockedStageRepToken,
    });
    expect((read.body['data'] as Record<string, unknown>)['stageId']).toBe(stagesA['New']);
  });
});

describe('sort and filter reach SQL only through the whitelist (CLAUDE.md §5.7)', () => {
  it('refuses every injection attempt through sort and leaves the table standing', async () => {
    const attempts = [
      "name'; drop table deals; --",
      'name) union select * from users --',
      '(select password_hash from auth_accounts)',
      'currency',
      'tenant_id',
      'deleted_at',
      'amount_minor',
    ];
    for (const sort of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/deals?sort=${encodeURIComponent(sort)}`,
        token: adminA.token,
      });
      expect(response.status, sort).toBe(422);
    }
    const check = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals',
      token: adminA.token,
    });
    expect(check.status).toBe(200);
  });

  it('refuses every injection attempt through filter', async () => {
    const attempts = [
      "name:eq:x' or '1'='1",
      'tenant_id:eq:' + tenantB,
      'deleted_at:is_not_null:',
      "name:contains:%' --",
      'custom_fields:eq:{}',
    ];
    for (const filter of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/deals?filter=${encodeURIComponent(filter)}`,
        token: adminA.token,
      });
      if (response.status === 200) {
        const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
        expect(ids, filter).not.toContain(dealB);
      } else {
        expect(response.status, filter).toBe(422);
      }
    }
  });

  it('cannot use a filter to read a soft-deleted deal back', async () => {
    const doomed = await harness.fixtures.createDeal(tenantA, {
      pipelineId: pipelineA,
      stageId: stagesA['New']!,
      ownerId: adminA.userId,
      name: 'Deleted order',
    });
    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${doomed}?version=1`,
      token: adminA.token,
    });
    expect(deleted.status).toBe(204);

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/deals?filter=name:eq:Deleted%20order&limit=100',
      token: adminA.token,
    });
    expect((response.body['data'] as unknown[]).length).toBe(0);
  });
});
