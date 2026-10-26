import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the deals module.
 *
 * Run against real Postgres with RLS on, like every other test here: the stage
 * rules, optimistic locking, keyset paging and the board's aggregation are
 * database behaviour, and a mock would simply agree with whatever this file
 * expects.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

interface Stage {
  id: string;
  name: string;
  stageType: 'open' | 'won' | 'lost';
}
let pipelineId: string;
let stages: Record<string, Stage>;
let otherPipelineId: string;
let otherStageId: string;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const tenant = await harness.fixtures.createTenant({ name: 'Deals Behaviour Co' });
  tenantId = tenant.tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };

  const pipelines = await harness.fixtures.pipelinesFor(tenantId);
  const main = pipelines.find((pipeline) => pipeline.isDefault)!;
  pipelineId = main.id;
  stages = Object.fromEntries(main.stages.map((stage) => [stage.name, stage]));

  // A second pipeline, to prove a stage cannot be borrowed across pipelines.
  const second = await harness.fixtures.createPipeline(tenantId, 'Wholesale', [
    { name: 'Enquiry', stageType: 'open', probability: 20 },
    { name: 'Closed won', stageType: 'won', probability: 100 },
  ]);
  otherPipelineId = second.pipelineId;
  otherStageId = second.stageIds[0]!;

  await harness.fixtures.setExchangeRate(tenantId, 'USD', 'INR', '83.25');
});

afterAll(async () => {
  await harness.close();
});

function createDeal(body: Record<string, unknown>) {
  return request(harness, { method: 'POST', url: '/api/v1/deals', token: admin.token, body });
}

function patchDeal(id: string, body: Record<string, unknown>) {
  return request(harness, {
    method: 'PATCH',
    url: `/api/v1/deals/${id}`,
    token: admin.token,
    body,
  });
}

async function makeDeal(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await createDeal({ name: 'Sample deal', ...body });
  expect(response.status).toBe(201);
  return response.body['data'] as Record<string, unknown>;
}

function errorOf(response: { body: Record<string, unknown> }): Record<string, unknown> {
  return response.body['error'] as Record<string, unknown>;
}

describe('pipelines', () => {
  it('seeds a default pipeline for a new tenant, with won and lost stages', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/pipelines',
      token: admin.token,
    });
    expect(response.status).toBe(200);

    const list = response.body['data'] as {
      id: string;
      isDefault: boolean;
      stages: { name: string; stageType: string; probability: number }[];
    }[];
    const main = list.find((pipeline) => pipeline.id === pipelineId)!;
    expect(main.isDefault).toBe(true);
    expect(main.stages.map((stage) => stage.stageType)).toEqual([
      'open',
      'open',
      'open',
      'open',
      'won',
      'lost',
    ]);
    expect(main.stages.find((stage) => stage.stageType === 'won')?.probability).toBe(100);
    // More than one pipeline per tenant (MVP_SPEC M5).
    expect(list.map((pipeline) => pipeline.id)).toContain(otherPipelineId);
  });
});

describe('create', () => {
  it('starts a deal in the first open stage of the default pipeline', async () => {
    const deal = await makeDeal({ name: 'Diwali order' });
    expect(deal['stageId']).toBe(stages['New']!.id);
    expect(deal['pipelineId']).toBe(pipelineId);
    // The stage's default, not zero.
    expect(deal['probability']).toBe(10);
    expect(deal['closedAt']).toBeNull();
    expect(deal['version']).toBe(1);
    expect(deal['ownerId']).toBe(admin.userId);
  });

  it('stores money as minor units and returns it as a string, exact past 2^53', async () => {
    const deal = await makeDeal({
      amount: { amountMinor: '9007199254740993', currency: 'inr' },
    });
    expect(deal['amount']).toEqual({ amountMinor: '9007199254740993', currency: 'INR' });
  });

  it('refuses an amount a bigint cannot hold, with a 422 rather than a 500', async () => {
    const response = await createDeal({
      name: 'Too big',
      amount: { amountMinor: '9999999999999999999', currency: 'INR' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses a currency code that is not real', async () => {
    const response = await createDeal({
      name: 'Odd currency',
      amount: { amountMinor: '100', currency: 'ZZ1' },
    });
    expect(response.status).toBe(422);
  });

  it('rejects an unknown key, and a client-supplied closedAt (CLAUDE.md §5.6, ADR-0020)', async () => {
    expect((await createDeal({ name: 'x', nickname: 'y' })).status).toBe(422);
    expect((await createDeal({ name: 'x', closedAt: '2026-01-01T00:00:00Z' })).status).toBe(422);
  });

  it('puts a deal straight into a won stage, closed at 100', async () => {
    const deal = await makeDeal({ stageId: stages['Won']!.id });
    expect(deal['probability']).toBe(100);
    expect(typeof deal['closedAt']).toBe('string');
  });

  it('requires a lost reason to create a deal in a lost stage', async () => {
    const refused = await createDeal({ name: 'Lost on arrival', stageId: stages['Lost']!.id });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(errorOf(refused)['details'])).toContain('lostReason');

    const deal = await makeDeal({ stageId: stages['Lost']!.id, lostReason: 'Budget cut' });
    expect(deal['lostReason']).toBe('Budget cut');
    expect(deal['probability']).toBe(0);
  });

  it('refuses a stage from a different pipeline than the one named', async () => {
    const response = await createDeal({ name: 'x', pipelineId, stageId: otherStageId });
    expect(response.status).toBe(422);
  });

  it('lets a stage name its own pipeline', async () => {
    const deal = await makeDeal({ stageId: otherStageId });
    expect(deal['pipelineId']).toBe(otherPipelineId);
    expect(deal['probability']).toBe(20);
  });

  it('refuses a probability on a closed stage that disagrees with it', async () => {
    const response = await createDeal({ name: 'x', stageId: stages['Won']!.id, probability: 40 });
    expect(response.status).toBe(422);
  });

  it('links people and an account, and writes an audit entry and an outbox event', async () => {
    const accountId = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Linked Co',
    });
    const contactId = await harness.fixtures.createContact(tenantId, { ownerId: admin.userId });

    const deal = await makeDeal({
      name: 'Audited deal',
      accountId,
      primaryContactId: contactId,
      contacts: [{ contactId, role: 'Decision maker' }],
    });
    expect(deal['accountId']).toBe(accountId);
    expect(deal['contacts']).toEqual([{ contactId, role: 'Decision maker' }]);

    const audit = await harness.fixtures.auditEntries(tenantId, 'deal');
    expect(audit.some((entry) => entry.recordId === deal['id'] && entry.action === 'create')).toBe(
      true,
    );
    const events = await harness.fixtures.outboxEvents(tenantId, 'deal.created.v1');
    expect(events.some((event) => event.recordId === deal['id'])).toBe(true);
  });

  it('refuses the same person twice on one deal', async () => {
    const contactId = await harness.fixtures.createContact(tenantId, { ownerId: admin.userId });
    const response = await createDeal({
      name: 'Twice',
      contacts: [{ contactId }, { contactId, role: 'Buyer' }],
    });
    expect(response.status).toBe(422);
  });
});

describe('moving a deal (MVP_SPEC M5 acceptance)', () => {
  it('sets closed_at and probability 100 on a move to a won stage, and records it', async () => {
    const deal = await makeDeal({ name: 'To be won' });
    const response = await patchDeal(deal['id'] as string, {
      stageId: stages['Won']!.id,
      version: 1,
    });
    expect(response.status).toBe(200);

    const moved = response.body['data'] as Record<string, unknown>;
    expect(moved['stageId']).toBe(stages['Won']!.id);
    expect(moved['probability']).toBe(100);
    expect(typeof moved['closedAt']).toBe('string');
    expect(moved['version']).toBe(2);

    // And in the database, not only in the serializer.
    const row = await harness.fixtures.dealRow(deal['id'] as string);
    expect(row?.probability).toBe(100);
    expect(row?.closed_at).toBeInstanceOf(Date);

    // An audit entry with the stage in its diff.
    const audit = (await harness.fixtures.auditEntries(tenantId, 'deal')).filter(
      (entry) => entry.recordId === deal['id'] && entry.action === 'update',
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.changes)).toContain(stages['Won']!.id);

    // And exactly one event for the timeline projector, naming both stages.
    const events = (await harness.fixtures.outboxEvents(tenantId, 'deal.stage_changed.v1')).filter(
      (event) => event.recordId === deal['id'],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      fromStageName: 'New',
      toStageName: 'Won',
      stageType: 'won',
    });
  });

  it('does not announce a plain move as a field edit as well', async () => {
    const deal = await makeDeal({ name: 'Only moved' });
    await patchDeal(deal['id'] as string, { stageId: stages['Qualified']!.id, version: 1 });

    const updated = (await harness.fixtures.outboxEvents(tenantId, 'deal.updated.v1')).filter(
      (event) => event.recordId === deal['id'],
    );
    expect(updated).toHaveLength(0);
  });

  it('announces both when a move comes with another edit', async () => {
    const deal = await makeDeal({ name: 'Moved and renamed' });
    await patchDeal(deal['id'] as string, {
      stageId: stages['Qualified']!.id,
      name: 'Renamed',
      version: 1,
    });

    const updated = (await harness.fixtures.outboxEvents(tenantId, 'deal.updated.v1')).filter(
      (event) => event.recordId === deal['id'],
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]!.payload['changedFields']).toEqual(['name']);
  });

  it('takes the new stage default probability when a move leaves it open', async () => {
    const deal = await makeDeal();
    const moved = await patchDeal(deal['id'] as string, {
      stageId: stages['Negotiation']!.id,
      version: 1,
    });
    expect((moved.body['data'] as Record<string, unknown>)['probability']).toBe(75);
  });

  it('requires a lost reason to move to a lost stage, and changes nothing without it', async () => {
    const deal = await makeDeal();
    const refused = await patchDeal(deal['id'] as string, {
      stageId: stages['Lost']!.id,
      version: 1,
    });
    expect(refused.status).toBe(422);

    const row = await harness.fixtures.dealRow(deal['id'] as string);
    expect(row?.stage_id).toBe(stages['New']!.id);
    expect(row?.version).toBe(1);
  });

  it('closes a deal as lost at probability 0 with the reason kept', async () => {
    const deal = await makeDeal();
    const response = await patchDeal(deal['id'] as string, {
      stageId: stages['Lost']!.id,
      lostReason: 'Chose a competitor',
      version: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body['data']).toMatchObject({
      probability: 0,
      lostReason: 'Chose a competitor',
    });
  });

  it('reopens a closed deal: closed_at and the lost reason are cleared', async () => {
    const deal = await makeDeal();
    await patchDeal(deal['id'] as string, {
      stageId: stages['Lost']!.id,
      lostReason: 'No budget',
      version: 1,
    });
    const reopened = await patchDeal(deal['id'] as string, {
      stageId: stages['Qualified']!.id,
      version: 2,
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body['data']).toMatchObject({
      closedAt: null,
      lostReason: null,
      probability: 25,
    });
  });

  it('keeps closed_at through an edit that leaves a won deal in its stage', async () => {
    const deal = await makeDeal({ stageId: stages['Won']!.id });
    const renamed = await patchDeal(deal['id'] as string, { name: 'Renamed win', version: 1 });
    expect(renamed.status).toBe(200);
    expect((renamed.body['data'] as Record<string, unknown>)['closedAt']).toBe(deal['closedAt']);
  });

  it('refuses a probability edit on a closed deal', async () => {
    const deal = await makeDeal({ stageId: stages['Won']!.id });
    expect((await patchDeal(deal['id'] as string, { probability: 50, version: 1 })).status).toBe(
      422,
    );
  });

  it('lets a rep set the probability of an open deal', async () => {
    const deal = await makeDeal();
    const response = await patchDeal(deal['id'] as string, { probability: 33, version: 1 });
    expect((response.body['data'] as Record<string, unknown>)['probability']).toBe(33);
  });

  it('refuses a stage from another pipeline unless the pipeline is changed with it', async () => {
    const deal = await makeDeal();
    expect(
      (await patchDeal(deal['id'] as string, { stageId: otherStageId, version: 1 })).status,
    ).toBe(422);
    expect(
      (await patchDeal(deal['id'] as string, { pipelineId: otherPipelineId, version: 1 })).status,
    ).toBe(422);

    const moved = await patchDeal(deal['id'] as string, {
      pipelineId: otherPipelineId,
      stageId: otherStageId,
      version: 1,
    });
    expect(moved.status).toBe(200);
    expect(moved.body['data']).toMatchObject({
      pipelineId: otherPipelineId,
      stageId: otherStageId,
    });
  });

  it('refuses a stale version with 409 and leaves the deal where the other user put it', async () => {
    const deal = await makeDeal();
    const first = await patchDeal(deal['id'] as string, {
      stageId: stages['Qualified']!.id,
      version: 1,
    });
    expect(first.status).toBe(200);

    // A second client still holding version 1 drags the same card.
    const stale = await patchDeal(deal['id'] as string, {
      stageId: stages['Proposal']!.id,
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)['code']).toBe('VERSION_CONFLICT');

    const row = await harness.fixtures.dealRow(deal['id'] as string);
    expect(row?.stage_id).toBe(stages['Qualified']!.id);
  });

  it('serialises two simultaneous drags: exactly one wins', async () => {
    const deal = await makeDeal();
    const results = await Promise.all([
      patchDeal(deal['id'] as string, { stageId: stages['Qualified']!.id, version: 1 }),
      patchDeal(deal['id'] as string, { stageId: stages['Proposal']!.id, version: 1 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it('replaces the people on a deal when contacts are sent, and leaves them when not', async () => {
    const one = await harness.fixtures.createContact(tenantId, { ownerId: admin.userId });
    const two = await harness.fixtures.createContact(tenantId, { ownerId: admin.userId });
    const deal = await makeDeal({ contacts: [{ contactId: one, role: 'Buyer' }] });

    const renamed = await patchDeal(deal['id'] as string, { name: 'Same people', version: 1 });
    expect((renamed.body['data'] as Record<string, unknown>)['contacts']).toEqual([
      { contactId: one, role: 'Buyer' },
    ]);

    const replaced = await patchDeal(deal['id'] as string, {
      contacts: [{ contactId: two, role: 'Approver' }],
      version: 2,
    });
    expect((replaced.body['data'] as Record<string, unknown>)['contacts']).toEqual([
      { contactId: two, role: 'Approver' },
    ]);

    const cleared = await patchDeal(deal['id'] as string, { contacts: [], version: 3 });
    expect((cleared.body['data'] as Record<string, unknown>)['contacts']).toEqual([]);
  });
});

describe('the database refuses what the service would', () => {
  it('rejects a won deal that is not closed, written around the API', async () => {
    await expect(
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages['Won']!.id,
        probability: 100,
        closedAt: null,
      }),
    ).rejects.toThrow(/won stage/i);
  });

  it('rejects a lost deal with no reason, and an open deal that is closed', async () => {
    await expect(
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages['Lost']!.id,
        probability: 0,
        closedAt: new Date(),
        lostReason: null,
      }),
    ).rejects.toThrow(/lost stage/i);
    await expect(
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages['New']!.id,
        closedAt: new Date(),
      }),
    ).rejects.toThrow(/open stage/i);
  });

  it('rejects a stage that belongs to a different pipeline', async () => {
    await expect(
      harness.fixtures.createDeal(tenantId, { pipelineId, stageId: otherStageId }),
    ).rejects.toThrow(/deals_stage_in_pipeline_fkey/);
  });

  it('rejects a negative amount and an amount with no currency', async () => {
    await expect(
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages['New']!.id,
        amountMinor: -1n,
        currency: 'INR',
      }),
    ).rejects.toThrow(/deals_amount_sign_chk/);
    await expect(
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages['New']!.id,
        amountMinor: 100n,
        currency: null,
      }),
    ).rejects.toThrow(/deals_amount_currency_chk/);
  });

  it('refuses to retype a stage that holds deals', async () => {
    const deal = await makeDeal({ stageId: stages['Qualified']!.id });
    expect(deal['id']).toBeDefined();
    await expect(harness.fixtures.setStageType(stages['Qualified']!.id, 'won')).rejects.toThrow(
      /holds deals/,
    );
  });
});

describe('list', () => {
  let listTenant: string;
  let listToken: string;
  let listStages: Record<string, Stage>;

  beforeAll(async () => {
    const tenant = await harness.fixtures.createTenant({ name: 'Deals List Co' });
    listTenant = tenant.tenantId;
    const roles = await harness.provision(listTenant);
    const user = await harness.fixtures.createUser(listTenant, roles.get('Admin')!);
    listToken = await harness.signIn(user.userId, listTenant);

    const pipelines = await harness.fixtures.pipelinesFor(listTenant);
    const main = pipelines.find((pipeline) => pipeline.isDefault)!;
    listStages = Object.fromEntries(main.stages.map((stage) => [stage.name, stage]));

    for (let index = 0; index < 7; index += 1) {
      await harness.fixtures.createDeal(listTenant, {
        pipelineId: main.id,
        stageId: index < 4 ? listStages['New']!.id : listStages['Qualified']!.id,
        ownerId: user.userId,
        name: `List deal ${index}`,
        amountMinor: BigInt((index + 1) * 100_000),
        currency: 'INR',
      });
    }
    // Written straight into the table, so index it: a list's search box is answered by the search
    // index (ADR-0041 §5).
    await harness.indexForSearch(listTenant);
  });

  function list(query: string) {
    return request(harness, {
      method: 'GET',
      url: `/api/v1/deals?${query}`,
      token: listToken,
    });
  }

  it('pages with a keyset cursor and never repeats or drops a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = new URLSearchParams({ limit: '3', sort: 'amount' });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await list(query.toString());
      expect(response.status).toBe(200);
      for (const row of response.body['data'] as { id: string }[]) seen.push(row.id);
      cursor = (response.body['meta'] as { nextCursor: string | null }).nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(3);
  });

  it('filters one column of the board by stage', async () => {
    const response = await list(`filter=stage_id:eq:${listStages['New']!.id}&limit=100`);
    expect((response.body['data'] as unknown[]).length).toBe(4);
  });

  it('sorts by amount, both ways', async () => {
    const ascending = await list('sort=amount&limit=100');
    const descending = await list('sort=-amount&limit=100');
    const amounts = (rows: Record<string, unknown>) =>
      (rows['data'] as { amount: { amountMinor: string } }[]).map((row) =>
        Number(row.amount.amountMinor),
      );
    expect(amounts(ascending.body)).toEqual([...amounts(ascending.body)].sort((a, b) => a - b));
    expect(amounts(descending.body)).toEqual(amounts(ascending.body).reverse());
  });

  it('filters by amount range and by name', async () => {
    const big = await list('filter=amount:gte:500000&limit=100');
    expect((big.body['data'] as unknown[]).length).toBe(3);

    // Words, by their start (ADR-0041 §5): every word must match, and each is a prefix.
    const all = await list('q=List%20deal');
    expect((all.body['data'] as unknown[]).length).toBe(7);
    const prefix = await list('q=Lis');
    expect((prefix.body['data'] as unknown[]).length).toBe(7);
    const none = await list('q=nonexistentword');
    expect((none.body['data'] as unknown[]).length).toBe(0);
  });

  it('matches a word by its start and not its middle: the substring match this replaced', async () => {
    // `eal` was inside 'deal' and matched under the old ILIKE; a word is now matched from its start.
    expect(((await list('q=eal')).body['data'] as unknown[]).length).toBe(0);
  });

  it('answers a malformed filter value with a 422, not a 500', async () => {
    expect((await list('filter=amount:gt:banana')).status).toBe(422);
    expect((await list('filter=expected_close_date:gt:banana')).status).toBe(422);
    expect((await list('filter=stage_id:eq:not-a-uuid')).status).toBe(422);
  });
});

describe('board totals (MVP_SPEC M5, ADR-0021)', () => {
  let boardTenant: string;
  let boardToken: string;
  let boardPipeline: string;
  let boardStages: Record<string, Stage>;

  beforeAll(async () => {
    const tenant = await harness.fixtures.createTenant({ name: 'Deals Board Co' });
    boardTenant = tenant.tenantId;
    const roles = await harness.provision(boardTenant);
    const user = await harness.fixtures.createUser(boardTenant, roles.get('Admin')!);
    boardToken = await harness.signIn(user.userId, boardTenant);

    const main = (await harness.fixtures.pipelinesFor(boardTenant)).find(
      (pipeline) => pipeline.isDefault,
    )!;
    boardPipeline = main.id;
    boardStages = Object.fromEntries(main.stages.map((stage) => [stage.name, stage]));

    // The tenant reports in INR; USD has a manual rate, EUR does not.
    await harness.fixtures.setExchangeRate(boardTenant, 'USD', 'INR', '83.25');

    const add = (stage: string, amountMinor: bigint | null, currency: string | null) =>
      harness.fixtures.createDeal(boardTenant, {
        pipelineId: boardPipeline,
        stageId: boardStages[stage]!.id,
        ownerId: user.userId,
        amountMinor,
        currency,
      });

    await add('New', 100_000n, 'INR');
    await add('New', 1_000n, 'USD');
    await add('New', 500n, 'EUR');
    await add('New', null, null);
    await add('Qualified', 250_000n, 'INR');
  });

  async function board(query = '') {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/board${query}`,
      token: boardToken,
    });
    expect(response.status).toBe(200);
    return response.body['data'] as {
      pipelineId: string;
      currency: string;
      columns: {
        stageId: string;
        count: number;
        total: { amountMinor: string; currency: string } | null;
        unconverted: { currency: string; count: number; amountMinor: string }[];
      }[];
    };
  }

  it('totals each column in the tenant currency using the stored rate', async () => {
    const result = await board();
    expect(result.pipelineId).toBe(boardPipeline);
    expect(result.currency).toBe('INR');

    const column = result.columns.find((entry) => entry.stageId === boardStages['New']!.id)!;
    // ₹1,000.00 + $10.00 at 83.25 = ₹1,832.50, in paise. The EUR deal is not in it.
    expect(column.total).toEqual({ amountMinor: '183250', currency: 'INR' });
    // A deal with no amount is still a deal in the column.
    expect(column.count).toBe(4);
  });

  it('says which currency had no rate instead of quietly leaving it out', async () => {
    const result = await board();
    const column = result.columns.find((entry) => entry.stageId === boardStages['New']!.id)!;
    expect(column.unconverted).toEqual([{ currency: 'EUR', count: 1, amountMinor: '500' }]);
  });

  it('shows every stage of the pipeline, empty ones as a zero total', async () => {
    const result = await board();
    expect(result.columns.map((column) => column.stageId)).toEqual(
      Object.values(boardStages).map((stage) => stage.id),
    );
    const won = result.columns.find((entry) => entry.stageId === boardStages['Won']!.id)!;
    expect(won).toMatchObject({ count: 0, total: { amountMinor: '0', currency: 'INR' } });
  });

  it('counts every deal in a column, however many cards a page loaded', async () => {
    const result = await board(`?pipelineId=${boardPipeline}`);
    const qualified = result.columns.find(
      (entry) => entry.stageId === boardStages['Qualified']!.id,
    )!;
    expect(qualified.total).toEqual({ amountMinor: '250000', currency: 'INR' });
  });

  it('follows a rate change at once, because rates are read on every request', async () => {
    await harness.fixtures.setExchangeRate(boardTenant, 'USD', 'INR', '90');
    const result = await board();
    const column = result.columns.find((entry) => entry.stageId === boardStages['New']!.id)!;
    expect(column.total).toEqual({ amountMinor: '190000', currency: 'INR' });
  });

  it('leaves deleted deals out of the totals', async () => {
    const dealId = await harness.fixtures.createDeal(boardTenant, {
      pipelineId: boardPipeline,
      stageId: boardStages['Proposal']!.id,
      amountMinor: 700_000n,
      currency: 'INR',
      ownerId: null,
    });
    const before = (await board()).columns.find(
      (entry) => entry.stageId === boardStages['Proposal']!.id,
    )!;
    expect(before.total?.amountMinor).toBe('700000');

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${dealId}?version=1`,
      token: boardToken,
    });
    expect(removed.status).toBe(204);

    const after = (await board()).columns.find(
      (entry) => entry.stageId === boardStages['Proposal']!.id,
    )!;
    expect(after).toMatchObject({ count: 0, total: { amountMinor: '0' } });
  });
});

describe('delete', () => {
  it('soft deletes with the version, audits it, and hides the deal', async () => {
    const deal = await makeDeal({ name: 'Doomed' });
    const id = deal['id'] as string;

    const stale = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${id}?version=9`,
      token: admin.token,
    });
    expect(stale.status).toBe(409);

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${id}?version=1`,
      token: admin.token,
    });
    expect(removed.status).toBe(204);

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/deals/${id}`,
      token: admin.token,
    });
    expect(read.status).toBe(404);

    // Soft: the row is still there for the Recycle Bin.
    expect((await harness.fixtures.dealRow(id))?.deleted_at).toBeInstanceOf(Date);
    const audit = await harness.fixtures.auditEntries(tenantId, 'deal');
    expect(audit.some((entry) => entry.recordId === id && entry.action === 'delete')).toBe(true);
  });
});
