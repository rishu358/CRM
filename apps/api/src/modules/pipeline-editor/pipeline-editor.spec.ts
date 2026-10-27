import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MAX_STAGES_PER_PIPELINE } from '@crm/core';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
 *
 * Real Postgres with RLS, the production guards and pipes: the stage rules, the ordering, the
 * concurrency and the move of deals out of a retired stage are database behaviour, and a mock would
 * simply agree with whatever this file expects. Each group makes its own pipeline, so no test
 * depends on what another left behind.
 */

interface Stage {
  id: string;
  name: string;
  position: number;
  probability: number;
  stageType: 'open' | 'won' | 'lost';
  version: number;
  archivedAt: string | null;
  dealCount: number;
  recycleBinDealCount: number;
}
interface Pipeline {
  id: string;
  name: string;
  version: number;
  stages: Stage[];
}
interface ArchiveResult {
  pipeline: Pipeline;
  movedDeals: number;
  movedRecycleBinDeals: number;
}

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Pipeline Editor Co' })).tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  await harness.fixtures.setExchangeRate(tenantId, 'USD', 'INR', '83.25');
});

afterAll(async () => {
  await harness.close();
});

const api = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    token: admin.token,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });

const errorOf = (response: { body: Record<string, unknown> }) =>
  response.body['error'] as {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };

let counter = 0;

/** A fresh pipeline: three open stages, a won and a lost one. */
async function freshPipeline(
  stages: { name: string; stageType: 'open' | 'won' | 'lost'; probability: number }[] = [
    { name: 'Lead in', stageType: 'open', probability: 10 },
    { name: 'Quote sent', stageType: 'open', probability: 40 },
    { name: 'Negotiating', stageType: 'open', probability: 70 },
    { name: 'Closed won', stageType: 'won', probability: 100 },
    { name: 'Closed lost', stageType: 'lost', probability: 0 },
  ],
): Promise<Pipeline> {
  counter += 1;
  const made = await harness.fixtures.createPipeline(tenantId, `Pipeline ${counter}`, stages);
  return managed(made.pipelineId);
}

async function managed(pipelineId: string): Promise<Pipeline> {
  const list = dataOf<Pipeline[]>(await api('GET', '/pipelines/manage'), 200);
  const found = list.find((pipeline) => pipeline.id === pipelineId);
  if (found === undefined) throw new Error('pipeline missing from the editor list');
  return found;
}

const stageNamed = (pipeline: Pipeline, name: string): Stage => {
  const found = pipeline.stages.find((stage) => stage.name === name);
  if (found === undefined) throw new Error(`no stage called ${name}`);
  return found;
};

const inUse = (pipeline: Pipeline) => pipeline.stages.filter((stage) => stage.archivedAt === null);
const namesInUse = (pipeline: Pipeline) => inUse(pipeline).map((stage) => stage.name);

async function makeDeal(
  pipeline: Pipeline,
  stageName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const stage = stageNamed(pipeline, stageName);
  const body: Record<string, unknown> = {
    name: `Deal in ${stageName}`,
    pipelineId: pipeline.id,
    stageId: stage.id,
    amount: { amountMinor: '100000', currency: 'INR' },
    ...extra,
  };
  if (stage.stageType === 'lost' && body['lostReason'] === undefined) {
    body['lostReason'] = 'Went with a competitor';
  }
  const response = await api('POST', '/deals', body);
  return dataOf<{ id: string }>(response, 201).id;
}

const patchStage = (pipeline: Pipeline, stage: Stage, body: Record<string, unknown>) =>
  api('PATCH', `/pipelines/${pipeline.id}/stages/${stage.id}`, { version: stage.version, ...body });

const archive = (pipeline: Pipeline, stage: Stage, body: Record<string, unknown> = {}) =>
  api('POST', `/pipelines/${pipeline.id}/stages/${stage.id}/archive`, {
    version: stage.version,
    ...body,
  });

async function dealRow(id: string) {
  const row = await harness.fixtures.dealRow(id);
  if (row === null) throw new Error('deal row missing');
  return {
    stageId: row.stage_id,
    probability: row.probability,
    closedAt: row.closed_at,
    lostReason: row.lost_reason,
  };
}

describe('the editor list', () => {
  it('shows every stage in board order with its version and what it holds', async () => {
    const pipeline = await freshPipeline();
    await makeDeal(pipeline, 'Lead in');
    await makeDeal(pipeline, 'Lead in');

    const view = await managed(pipeline.id);
    expect(view.stages.map((stage) => stage.name)).toEqual([
      'Lead in',
      'Quote sent',
      'Negotiating',
      'Closed won',
      'Closed lost',
    ]);
    expect(stageNamed(view, 'Lead in')).toMatchObject({
      version: 1,
      archivedAt: null,
      dealCount: 2,
      recycleBinDealCount: 0,
    });
    expect(view.version).toBe(1);
  });
});

describe('adding a stage', () => {
  it('puts an open stage before the won and lost stages, and closed ones last', async () => {
    const pipeline = await freshPipeline();

    const afterOpen = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, {
        name: '  Site visit  ',
        stageType: 'open',
        probability: 55,
      }),
      201,
    );
    expect(namesInUse(afterOpen)).toEqual([
      'Lead in',
      'Quote sent',
      'Negotiating',
      'Site visit',
      'Closed won',
      'Closed lost',
    ]);
    expect(stageNamed(afterOpen, 'Site visit')).toMatchObject({
      probability: 55,
      stageType: 'open',
    });

    const afterWon = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, {
        name: 'Repeat order',
        stageType: 'won',
      }),
      201,
    );
    expect(namesInUse(afterWon).at(-1)).toBe('Repeat order');
    expect(stageNamed(afterWon, 'Repeat order').probability).toBe(100);

    // Positions are dense and unique, and the pipeline's version moved.
    expect(inUse(afterWon).map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(afterWon.version).toBeGreaterThan(pipeline.version);
  });

  it('defaults an open stage to 50 and a lost stage to 0', async () => {
    const pipeline = await freshPipeline();
    const view = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Maybe' }),
      201,
    );
    expect(stageNamed(view, 'Maybe')).toMatchObject({ stageType: 'open', probability: 50 });
    const lost = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Ghosted', stageType: 'lost' }),
      201,
    );
    expect(stageNamed(lost, 'Ghosted').probability).toBe(0);
  });

  it('refuses a name already used in the pipeline, ignoring case and spacing', async () => {
    const pipeline = await freshPipeline();
    const response = await api('POST', `/pipelines/${pipeline.id}/stages`, {
      name: '  QUOTE sent ',
    });
    expect(response.status).toBe(409);
    expect(errorOf(response).details?.[0]?.path).toBe('name');
  });

  it('allows the same name in another pipeline', async () => {
    const one = await freshPipeline();
    const two = await freshPipeline();
    const response = await api('POST', `/pipelines/${two.id}/stages`, { name: 'Lead in 2' });
    expect(response.status).toBe(201);
    expect(namesInUse(one)).not.toContain('Lead in 2');
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name over 60 characters', { name: 'x'.repeat(61) }],
    ['a probability over 100', { name: 'Hot', probability: 101 }],
    ['a negative probability', { name: 'Cold', probability: -1 }],
    ['a fractional probability', { name: 'Odd', probability: 12.5 }],
    ['a won stage that is not 100', { name: 'Won-ish', stageType: 'won', probability: 90 }],
    ['a lost stage that is not 0', { name: 'Lost-ish', stageType: 'lost', probability: 10 }],
    ['an unknown key', { name: 'Sneaky', tenantId: '0198f0f0-0000-7000-8000-000000000000' }],
    ['a made-up type', { name: 'Odd type', stageType: 'maybe' }],
  ])('refuses %s with a 422', async (_label, body) => {
    const pipeline = await freshPipeline();
    const response = await api('POST', `/pipelines/${pipeline.id}/stages`, body);
    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
  });

  it('accepts a name of exactly 60 characters', async () => {
    const pipeline = await freshPipeline();
    const response = await api('POST', `/pipelines/${pipeline.id}/stages`, {
      name: 'x'.repeat(60),
    });
    expect(response.status).toBe(201);
  });

  it('stops at the cap on stages per pipeline', async () => {
    const pipeline = await freshPipeline();
    const room = MAX_STAGES_PER_PIPELINE - pipeline.stages.length;
    for (let index = 0; index < room; index += 1) {
      const response = await api('POST', `/pipelines/${pipeline.id}/stages`, {
        name: `Step ${index}`,
      });
      expect(response.status).toBe(201);
    }
    const over = await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'One too many' });
    expect(over.status).toBe(422);
    const view = await managed(pipeline.id);
    expect(inUse(view)).toHaveLength(MAX_STAGES_PER_PIPELINE);
  });

  it('adds one stage for a retried Idempotency-Key, and refuses the key with a different body', async () => {
    const pipeline = await freshPipeline();
    const headers = { 'idempotency-key': `stage-${pipeline.id}` };
    const first = await api(
      'POST',
      `/pipelines/${pipeline.id}/stages`,
      { name: 'Once only' },
      headers,
    );
    const again = await api(
      'POST',
      `/pipelines/${pipeline.id}/stages`,
      { name: 'Once only' },
      headers,
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const view = await managed(pipeline.id);
    expect(namesInUse(view).filter((name) => name === 'Once only')).toHaveLength(1);

    const different = await api(
      'POST',
      `/pipelines/${pipeline.id}/stages`,
      { name: 'Something else' },
      headers,
    );
    expect(different.status).toBe(409);
    expect(errorOf(different).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('changing a stage', () => {
  it('renames without touching history, and bumps only that stage', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    const dealId = await makeDeal(pipeline, 'Quote sent');

    const view = dataOf<Pipeline>(
      await patchStage(pipeline, stage, { name: '  Proposal sent ' }),
      200,
    );
    expect(stageNamed(view, 'Proposal sent')).toMatchObject({
      id: stage.id,
      version: stage.version + 1,
    });
    expect(stageNamed(view, 'Lead in').version).toBe(1);
    // The deal is still in the same stage: a rename moves nothing.
    expect((await dealRow(dealId)).stageId).toBe(stage.id);
  });

  it('answers 409 to a stale version and applies nothing', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    dataOf(await patchStage(pipeline, stage, { name: 'First rename' }), 200);

    const stale = await patchStage(pipeline, stage, { name: 'Second rename' });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    expect(namesInUse(await managed(pipeline.id))).toContain('First rename');
  });

  it('refuses a rename onto another stage name, but allows changing only the case of its own', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    expect((await patchStage(pipeline, stage, { name: 'LEAD IN' })).status).toBe(409);
    const own = await patchStage(pipeline, stage, { name: 'quote SENT' });
    expect(own.status).toBe(200);
  });

  it('sets the probability of an open stage and refuses a number the database would', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    expect(
      stageNamed(
        dataOf<Pipeline>(await patchStage(pipeline, stage, { probability: 0 }), 200),
        'Quote sent',
      ).probability,
    ).toBe(0);
    const fresh = stageNamed(await managed(pipeline.id), 'Quote sent');
    expect((await patchStage(pipeline, fresh, { probability: 101 })).status).toBe(422);
    expect((await patchStage(pipeline, fresh, { probability: 33.5 })).status).toBe(422);
  });

  it('keeps a won stage at 100 and a lost stage at 0', async () => {
    const pipeline = await freshPipeline();
    const won = stageNamed(pipeline, 'Closed won');
    const lost = stageNamed(pipeline, 'Closed lost');
    expect((await patchStage(pipeline, won, { probability: 90 })).status).toBe(422);
    expect((await patchStage(pipeline, lost, { probability: 5 })).status).toBe(422);
    expect((await patchStage(pipeline, won, { probability: 100 })).status).toBe(200);
  });

  it('refuses an empty change and an unknown key', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    expect((await patchStage(pipeline, stage, {})).status).toBe(422);
    expect((await patchStage(pipeline, stage, { name: 'ok', version2: 1 })).status).toBe(422);
  });

  it('retypes a stage that holds no deals and fixes its probability to the new type', async () => {
    const pipeline = await freshPipeline();
    const extra = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, {
        name: 'Maybe won',
        stageType: 'open',
        probability: 60,
      }),
      201,
    );
    // The new open stage sits right before Won, so becoming a won stage in place keeps the order valid.
    const stage = stageNamed(extra, 'Maybe won');
    const retyped = dataOf<Pipeline>(await patchStage(extra, stage, { stageType: 'won' }), 200);
    expect(stageNamed(retyped, 'Maybe won')).toMatchObject({ stageType: 'won', probability: 100 });
    expect(retyped.version).toBeGreaterThan(extra.version);

    // A stage in front of other open stages cannot become won: open stages come first.
    const first = stageNamed(retyped, 'Lead in');
    const refused = await patchStage(retyped, first, { stageType: 'won' });
    expect(refused.status).toBe(422);
    expect(errorOf(refused).details?.[0]?.message).toMatch(/Open stages come first/);
  });

  it('refuses to retype a stage that holds deals, live or in the Recycle Bin', async () => {
    const pipeline = await freshPipeline();
    const live = stageNamed(pipeline, 'Negotiating');
    await makeDeal(pipeline, 'Negotiating');
    const refused = await patchStage(pipeline, live, { stageType: 'won' });
    expect(refused.status).toBe(422);
    expect(errorOf(refused).details?.[0]?.path).toBe('stageType');

    // The only deal now sits in the bin: it still counts.
    const binned = stageNamed(pipeline, 'Quote sent');
    const dealId = await makeDeal(pipeline, 'Quote sent');
    const deal = dataOf<{ version: number }>(await api('GET', `/deals/${dealId}`), 200);
    expect((await api('DELETE', `/deals/${dealId}?version=${deal.version}`)).status).toBe(204);
    expect((await patchStage(pipeline, binned, { stageType: 'lost' })).status).toBe(422);
  });

  it('cannot retype the last open stage away', async () => {
    const pipeline = await freshPipeline([
      { name: 'Only open', stageType: 'open', probability: 20 },
      { name: 'Won', stageType: 'won', probability: 100 },
      { name: 'Lost', stageType: 'lost', probability: 0 },
    ]);
    const response = await patchStage(pipeline, stageNamed(pipeline, 'Only open'), {
      stageType: 'lost',
    });
    expect(response.status).toBe(422);
  });

  it('applies two renames of the same stage at once as one success and one 409', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    const [one, two] = await Promise.all([
      patchStage(pipeline, stage, { name: 'Racer one' }),
      patchStage(pipeline, stage, { name: 'Racer two' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const view = await managed(pipeline.id);
    const names = namesInUse(view);
    expect(names.filter((name) => name.startsWith('Racer'))).toHaveLength(1);
  });

  it('applies renames of two different stages at once', async () => {
    const pipeline = await freshPipeline();
    const [one, two] = await Promise.all([
      patchStage(pipeline, stageNamed(pipeline, 'Lead in'), { name: 'Enquiry' }),
      patchStage(pipeline, stageNamed(pipeline, 'Quote sent'), { name: 'Estimate' }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(namesInUse(await managed(pipeline.id))).toEqual([
      'Enquiry',
      'Estimate',
      'Negotiating',
      'Closed won',
      'Closed lost',
    ]);
  });

  it('refuses a retired stage until it is restored', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    dataOf(await archive(pipeline, stage), 200);
    const retired = stageNamed(await managed(pipeline.id), 'Quote sent');
    expect((await patchStage(pipeline, retired, { name: 'Back' })).status).toBe(409);
  });
});

describe('ordering', () => {
  it('reorders the open stages and keeps positions dense', async () => {
    const pipeline = await freshPipeline();
    const ids = ['Negotiating', 'Lead in', 'Quote sent', 'Closed won', 'Closed lost'].map(
      (name) => stageNamed(pipeline, name).id,
    );
    const view = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: pipeline.version,
        stageIds: ids,
      }),
      200,
    );
    expect(namesInUse(view)).toEqual([
      'Negotiating',
      'Lead in',
      'Quote sent',
      'Closed won',
      'Closed lost',
    ]);
    expect(inUse(view).map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4]);
    expect(view.version).toBe(pipeline.version + 1);

    // The board (GET /pipelines) shows the same order.
    const board = dataOf<{ id: string; stages: { name: string }[] }[]>(
      await api('GET', '/pipelines'),
      200,
    );
    expect(board.find((entry) => entry.id === pipeline.id)?.stages.map((s) => s.name)).toEqual(
      namesInUse(view),
    );
  });

  it('refuses a list that leaves a stage out, repeats one, or names a stranger', async () => {
    const pipeline = await freshPipeline();
    const ids = inUse(pipeline).map((stage) => stage.id);
    const order = (stageIds: string[]) =>
      api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: pipeline.version,
        stageIds,
      });

    expect((await order(ids.slice(1))).status).toBe(422);
    expect((await order([ids[0]!, ...ids.slice(0, -1)])).status).toBe(422);
    expect(
      (await order([...ids.slice(0, -1), '0198f0f0-0000-7000-8000-000000000000'])).status,
    ).toBe(422);
    expect((await order([])).status).toBe(422);
    // Nothing changed.
    expect(namesInUse(await managed(pipeline.id))).toEqual(namesInUse(pipeline));
  });

  it('refuses an order that puts a won or lost stage before an open one', async () => {
    const pipeline = await freshPipeline();
    const ids = ['Closed won', 'Lead in', 'Quote sent', 'Negotiating', 'Closed lost'].map(
      (name) => stageNamed(pipeline, name).id,
    );
    const response = await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
      version: pipeline.version,
      stageIds: ids,
    });
    expect(response.status).toBe(422);
  });

  it('answers 409 to a stale pipeline version', async () => {
    const pipeline = await freshPipeline();
    const ids = inUse(pipeline).map((stage) => stage.id);
    dataOf(
      await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: pipeline.version,
        stageIds: [ids[1]!, ids[0]!, ...ids.slice(2)],
      }),
      200,
    );
    const stale = await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
      version: pipeline.version,
      stageIds: ids,
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
  });

  it('refuses a reorder made before a colleague added a stage', async () => {
    const pipeline = await freshPipeline();
    const ids = inUse(pipeline).map((stage) => stage.id);
    dataOf(
      await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Added by someone else' }),
      201,
    );
    const response = await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
      version: pipeline.version,
      stageIds: [ids[1]!, ids[0]!, ...ids.slice(2)],
    });
    expect(response.status).toBe(409);
  });

  it('applies two reorders sent at once one after the other, never leaving two stages in one place', async () => {
    const pipeline = await freshPipeline();
    const byName = (names: string[]) => names.map((name) => stageNamed(pipeline, name).id);
    const a = byName(['Negotiating', 'Quote sent', 'Lead in', 'Closed won', 'Closed lost']);
    const b = byName(['Quote sent', 'Negotiating', 'Lead in', 'Closed lost', 'Closed won']);

    const [one, two] = await Promise.all([
      api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: pipeline.version,
        stageIds: a,
      }),
      api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: pipeline.version,
        stageIds: b,
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);

    const view = await managed(pipeline.id);
    expect(inUse(view).map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4]);
    const winner = one.status === 200 ? a : b;
    expect(inUse(view).map((stage) => stage.id)).toEqual(winner);
  });

  it('survives many reorders racing each other with the right version each time', async () => {
    const pipeline = await freshPipeline();
    const ids = inUse(pipeline).map((stage) => stage.id);
    let version = pipeline.version;
    for (let round = 0; round < 6; round += 1) {
      // Never the order it already has, or the request is (rightly) a no-op.
      const shift = (round % 2) + 1;
      const rotated = [...ids.slice(shift, 3), ...ids.slice(0, shift), ids[3]!, ids[4]!];
      const responses = await Promise.all(
        [0, 1, 2].map(() =>
          api('POST', `/pipelines/${pipeline.id}/stages/order`, { version, stageIds: rotated }),
        ),
      );
      expect(responses.filter((response) => response.status === 200).length).toBeGreaterThanOrEqual(
        1,
      );
      version = (await managed(pipeline.id)).version;
      const positions = inUse(await managed(pipeline.id)).map((stage) => stage.position);
      expect(positions).toEqual([0, 1, 2, 3, 4]);
    }
  });
});

describe('retiring a stage', () => {
  it('retires an empty stage with no target and closes the gap', async () => {
    const pipeline = await freshPipeline();
    const result = dataOf<ArchiveResult>(
      await archive(pipeline, stageNamed(pipeline, 'Quote sent')),
      200,
    );
    expect(result.movedDeals).toBe(0);
    expect(namesInUse(result.pipeline)).toEqual([
      'Lead in',
      'Negotiating',
      'Closed won',
      'Closed lost',
    ]);
    expect(inUse(result.pipeline).map((stage) => stage.position)).toEqual([0, 1, 2, 3]);
    const retired = stageNamed(result.pipeline, 'Quote sent');
    expect(retired.archivedAt).not.toBeNull();
    // Retired stages are listed after the ones in use, and are not on the board.
    expect(result.pipeline.stages.at(-1)?.name).toBe('Quote sent');
    const board = dataOf<{ id: string; stages: { name: string }[] }[]>(
      await api('GET', '/pipelines'),
      200,
    );
    expect(
      board.find((entry) => entry.id === pipeline.id)?.stages.map((s) => s.name),
    ).not.toContain('Quote sent');
  });

  it('asks for a target when the stage holds deals, and says how many', async () => {
    const pipeline = await freshPipeline();
    await makeDeal(pipeline, 'Quote sent');
    await makeDeal(pipeline, 'Quote sent');
    const response = await archive(pipeline, stageNamed(pipeline, 'Quote sent'));
    expect(response.status).toBe(422);
    expect(errorOf(response).details?.[0]).toMatchObject({ path: 'moveDealsToStageId' });
    expect(errorOf(response).details?.[0]?.message).toMatch(/2 deals/);
    expect(stageNamed(await managed(pipeline.id), 'Quote sent').archivedAt).toBeNull();
  });

  it('moves every deal to the target in one go: stage, probability, audit, event, count', async () => {
    const pipeline = await freshPipeline();
    const from = stageNamed(pipeline, 'Quote sent');
    const to = stageNamed(pipeline, 'Negotiating');
    const ids = [
      await makeDeal(pipeline, 'Quote sent'),
      await makeDeal(pipeline, 'Quote sent'),
      await makeDeal(pipeline, 'Quote sent'),
    ];

    const result = dataOf<ArchiveResult>(
      await archive(pipeline, from, { moveDealsToStageId: to.id }),
      200,
    );
    expect(result.movedDeals).toBe(3);
    expect(result.movedRecycleBinDeals).toBe(0);
    expect(stageNamed(result.pipeline, 'Negotiating').dealCount).toBe(3);

    for (const id of ids) {
      const row = await dealRow(id);
      expect(row.stageId).toBe(to.id);
      expect(row.probability).toBe(70);
      expect(row.closedAt).toBeNull();
    }

    const moved = (await harness.fixtures.outboxEvents(tenantId, 'deal.stage_changed.v1')).filter(
      (event) =>
        event.recordId !== null &&
        ids.includes(event.recordId) &&
        event.payload['reason'] === 'stage_retired',
    );
    expect(moved).toHaveLength(3);
    expect(moved[0]?.payload).toMatchObject({
      fromStageId: from.id,
      fromStageName: 'Quote sent',
      toStageId: to.id,
      toStageName: 'Negotiating',
      stageType: 'open',
    });

    const dealAudit = (await harness.fixtures.auditEntries(tenantId, 'deal')).filter(
      (entry) =>
        entry.recordId !== null && ids.includes(entry.recordId) && entry.action === 'update',
    );
    expect(dealAudit).toHaveLength(3);

    const stageAudit = (await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).filter(
      (entry) => entry.recordId === from.id,
    );
    expect(stageAudit.map((entry) => entry.action)).toContain('delete');
    const events = (
      await harness.fixtures.outboxEvents(tenantId, 'pipeline_stage.archived.v1')
    ).filter((event) => event.recordId === from.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ movedDeals: 3, movedToStageId: to.id });
  });

  it('moves deals in the Recycle Bin too, so a restore lands in a stage in use', async () => {
    const pipeline = await freshPipeline();
    const from = stageNamed(pipeline, 'Quote sent');
    const to = stageNamed(pipeline, 'Lead in');
    const live = await makeDeal(pipeline, 'Quote sent');
    const binned = await makeDeal(pipeline, 'Quote sent');
    const detail = dataOf<{ version: number }>(await api('GET', `/deals/${binned}`), 200);
    expect((await api('DELETE', `/deals/${binned}?version=${detail.version}`)).status).toBe(204);

    const before = await managed(pipeline.id);
    expect(stageNamed(before, 'Quote sent')).toMatchObject({
      dealCount: 1,
      recycleBinDealCount: 1,
    });

    const result = dataOf<ArchiveResult>(
      await archive(before, stageNamed(before, 'Quote sent'), { moveDealsToStageId: to.id }),
      200,
    );
    expect(result).toMatchObject({ movedDeals: 1, movedRecycleBinDeals: 1 });
    expect((await dealRow(live)).stageId).toBe(to.id);
    expect((await dealRow(binned)).stageId).toBe(to.id);
    expect(from.id).not.toBe(to.id);
  });

  it('keeps when a won deal closed, and its place in "won this month"', async () => {
    const pipeline = await freshPipeline([
      { name: 'Open', stageType: 'open', probability: 20 },
      { name: 'Won old', stageType: 'won', probability: 100 },
      { name: 'Won new', stageType: 'won', probability: 100 },
      { name: 'Lost', stageType: 'lost', probability: 0 },
    ]);
    const closedAt = new Date();
    closedAt.setMinutes(closedAt.getMinutes() - 5);
    const dealId = await harness.fixtures.createDeal(tenantId, {
      pipelineId: pipeline.id,
      stageId: stageNamed(pipeline, 'Won old').id,
      ownerId: admin.userId,
      amountMinor: 123_400n,
      currency: 'INR',
      probability: 100,
      closedAt,
    });

    const wonBefore = dataOf<{ current: { total: { amountMinor: string } | null; count: number } }>(
      await api('GET', '/dashboard/won'),
      200,
    ).current;

    const result = dataOf<ArchiveResult>(
      await archive(pipeline, stageNamed(pipeline, 'Won old'), {
        moveDealsToStageId: stageNamed(pipeline, 'Won new').id,
      }),
      200,
    );
    expect(result.movedDeals).toBe(1);

    const row = await dealRow(dealId);
    expect(row.stageId).toBe(stageNamed(pipeline, 'Won new').id);
    expect(row.closedAt?.toISOString()).toBe(closedAt.toISOString());
    expect(row.probability).toBe(100);

    const wonAfter = dataOf<{ current: { total: { amountMinor: string } | null; count: number } }>(
      await api('GET', '/dashboard/won'),
      200,
    ).current;
    expect(wonAfter).toEqual(wonBefore);
  });

  it('keeps the closed date and the lost reason of a lost deal', async () => {
    const pipeline = await freshPipeline([
      { name: 'Open', stageType: 'open', probability: 20 },
      { name: 'Won', stageType: 'won', probability: 100 },
      { name: 'Lost: price', stageType: 'lost', probability: 0 },
      { name: 'Lost: other', stageType: 'lost', probability: 0 },
    ]);
    const closedAt = new Date('2026-03-04T10:00:00Z');
    const dealId = await harness.fixtures.createDeal(tenantId, {
      pipelineId: pipeline.id,
      stageId: stageNamed(pipeline, 'Lost: price').id,
      ownerId: admin.userId,
      probability: 0,
      closedAt,
      lostReason: 'Too expensive',
    });
    dataOf(
      await archive(pipeline, stageNamed(pipeline, 'Lost: price'), {
        moveDealsToStageId: stageNamed(pipeline, 'Lost: other').id,
      }),
      200,
    );
    const row = await dealRow(dealId);
    expect(row.stageId).toBe(stageNamed(pipeline, 'Lost: other').id);
    expect(row.closedAt?.toISOString()).toBe(closedAt.toISOString());
    expect(row.lostReason).toBe('Too expensive');
    expect(row.probability).toBe(0);
  });

  it('refuses to move open deals into a won or lost stage, and won deals into a lost one', async () => {
    const pipeline = await freshPipeline();
    await makeDeal(pipeline, 'Quote sent');
    const from = stageNamed(pipeline, 'Quote sent');
    for (const target of ['Closed won', 'Closed lost']) {
      const response = await archive(pipeline, from, {
        moveDealsToStageId: stageNamed(pipeline, target).id,
      });
      expect(response.status).toBe(422);
      expect(errorOf(response).details?.[0]?.message).toMatch(/on the board/);
    }
    expect(stageNamed(await managed(pipeline.id), 'Quote sent').archivedAt).toBeNull();
  });

  it('refuses a target that is the stage itself, retired, in another pipeline, or made up', async () => {
    const pipeline = await freshPipeline();
    const other = await freshPipeline();
    await makeDeal(pipeline, 'Quote sent');
    const from = stageNamed(pipeline, 'Quote sent');
    for (const target of [
      from.id,
      stageNamed(other, 'Lead in').id,
      '0198f0f0-0000-7000-8000-000000000000',
    ]) {
      const response = await archive(pipeline, from, { moveDealsToStageId: target });
      expect(response.status).toBe(422);
    }
    dataOf(await archive(pipeline, stageNamed(pipeline, 'Lead in')), 200);
    const retired = stageNamed(await managed(pipeline.id), 'Lead in');
    expect((await archive(pipeline, from, { moveDealsToStageId: retired.id })).status).toBe(422);
    // Nothing moved anywhere.
    expect(stageNamed(await managed(other.id), 'Lead in').dealCount).toBe(0);
  });

  it('keeps one open, one won and one lost stage in use', async () => {
    const pipeline = await freshPipeline([
      { name: 'Only open', stageType: 'open', probability: 20 },
      { name: 'Only won', stageType: 'won', probability: 100 },
      { name: 'Only lost', stageType: 'lost', probability: 0 },
    ]);
    for (const name of ['Only open', 'Only won', 'Only lost']) {
      const response = await archive(pipeline, stageNamed(pipeline, name));
      expect(response.status).toBe(422);
    }
    expect(inUse(await managed(pipeline.id))).toHaveLength(3);
  });

  it('answers 409 to a stale version, and to a stage that is already retired', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    dataOf(await patchStage(pipeline, stage, { name: 'Renamed first' }), 200);
    expect((await archive(pipeline, stage)).status).toBe(409);

    const fresh = stageNamed(await managed(pipeline.id), 'Renamed first');
    dataOf(await archive(pipeline, fresh), 200);
    const retired = stageNamed(await managed(pipeline.id), 'Renamed first');
    expect((await archive(pipeline, retired)).status).toBe(409);
  });

  it('does not let a deal be created in, or moved into, a retired stage', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    dataOf(await archive(pipeline, stage), 200);

    const create = await api('POST', '/deals', {
      name: 'Late',
      pipelineId: pipeline.id,
      stageId: stage.id,
    });
    expect(create.status).toBe(422);

    const dealId = await makeDeal(pipeline, 'Lead in');
    const detail = dataOf<{ version: number }>(await api('GET', `/deals/${dealId}`), 200);
    const move = await api('PATCH', `/deals/${dealId}`, {
      version: detail.version,
      stageId: stage.id,
    });
    expect(move.status).toBe(422);
  });

  it('starts new deals in the first open stage in use after the first one is retired', async () => {
    const pipeline = await freshPipeline();
    dataOf(await archive(pipeline, stageNamed(pipeline, 'Lead in')), 200);
    const response = await api('POST', '/deals', { name: 'Fresh', pipelineId: pipeline.id });
    const deal = dataOf<{ stageId: string }>(response, 201);
    expect(deal.stageId).toBe(stageNamed(pipeline, 'Quote sent').id);
  });
});

describe('the board and the dashboard after a change', () => {
  it('keep every deal and the open total, with the stage columns following the edit', async () => {
    const pipeline = await freshPipeline();
    await makeDeal(pipeline, 'Lead in', { amount: { amountMinor: '500000', currency: 'INR' } });
    await makeDeal(pipeline, 'Quote sent', { amount: { amountMinor: '250000', currency: 'INR' } });
    await makeDeal(pipeline, 'Quote sent', { amount: { amountMinor: '10000', currency: 'USD' } });

    type Dash = {
      stages: { name: string; count: number; total: { amountMinor: string } | null }[];
      open: { count: number; total: { amountMinor: string } | null };
    };
    const before = dataOf<Dash>(
      await api('GET', `/dashboard/pipeline?pipelineId=${pipeline.id}`),
      200,
    );
    expect(before.open).toMatchObject({ count: 3, total: { amountMinor: '1582500' } });

    dataOf(
      await archive(pipeline, stageNamed(pipeline, 'Quote sent'), {
        moveDealsToStageId: stageNamed(pipeline, 'Negotiating').id,
      }),
      200,
    );
    const renamed = await managed(pipeline.id);
    dataOf(await patchStage(renamed, stageNamed(renamed, 'Lead in'), { name: 'Enquiry' }), 200);

    const after = dataOf<Dash>(
      await api('GET', `/dashboard/pipeline?pipelineId=${pipeline.id}`),
      200,
    );
    expect(after.stages.map((stage) => stage.name)).toEqual(['Enquiry', 'Negotiating']);
    expect(after.stages.map((stage) => stage.count)).toEqual([1, 2]);
    expect(after.open).toEqual(before.open);

    const board = dataOf<{ columns: { stageId: string; count: number }[] }>(
      await api('GET', `/deals/board?pipelineId=${pipeline.id}`),
      200,
    );
    const live = inUse(await managed(pipeline.id));
    expect(board.columns.map((column) => column.stageId)).toEqual(live.map((stage) => stage.id));
    expect(board.columns.reduce((sum, column) => sum + column.count, 0)).toBe(3);
  });
});

describe('restoring a stage', () => {
  it('brings a retired open stage back among the open stages, empty', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Quote sent');
    dataOf(await archive(pipeline, stage), 200);
    const retired = stageNamed(await managed(pipeline.id), 'Quote sent');

    const view = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages/${retired.id}/restore`, {
        version: retired.version,
      }),
      200,
    );
    expect(namesInUse(view)).toEqual([
      'Lead in',
      'Negotiating',
      'Quote sent',
      'Closed won',
      'Closed lost',
    ]);
    expect(stageNamed(view, 'Quote sent')).toMatchObject({ archivedAt: null, dealCount: 0 });
    expect(inUse(view).map((entry) => entry.position)).toEqual([0, 1, 2, 3, 4]);

    const audit = (await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).filter(
      (entry) => entry.recordId === stage.id,
    );
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['delete', 'restore']),
    );
  });

  it('refuses when another stage in use has the name now, and when it is not retired', async () => {
    const pipeline = await freshPipeline();
    dataOf(await archive(pipeline, stageNamed(pipeline, 'Quote sent')), 200);
    dataOf(await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Quote sent' }), 201);
    const retired = (await managed(pipeline.id)).stages.find((stage) => stage.archivedAt !== null)!;
    const response = await api('POST', `/pipelines/${pipeline.id}/stages/${retired.id}/restore`, {
      version: retired.version,
    });
    expect(response.status).toBe(409);

    const live = stageNamed(await managed(pipeline.id), 'Lead in');
    const notRetired = await api('POST', `/pipelines/${pipeline.id}/stages/${live.id}/restore`, {
      version: live.version,
    });
    expect(notRetired.status).toBe(409);
  });

  it('refuses a stale version', async () => {
    const pipeline = await freshPipeline();
    dataOf(await archive(pipeline, stageNamed(pipeline, 'Quote sent')), 200);
    const retired = (await managed(pipeline.id)).stages.find((stage) => stage.archivedAt !== null)!;
    const response = await api('POST', `/pipelines/${pipeline.id}/stages/${retired.id}/restore`, {
      version: retired.version - 1 || 99,
    });
    expect(response.status).toBe(409);
  });

  it('refuses to restore past the cap', async () => {
    const pipeline = await freshPipeline();
    dataOf(await archive(pipeline, stageNamed(pipeline, 'Quote sent')), 200);
    const view = await managed(pipeline.id);
    for (let index = inUse(view).length; index < MAX_STAGES_PER_PIPELINE; index += 1) {
      dataOf(
        await api('POST', `/pipelines/${pipeline.id}/stages`, { name: `Filler ${index}` }),
        201,
      );
    }
    const retired = (await managed(pipeline.id)).stages.find((stage) => stage.archivedAt !== null)!;
    const response = await api('POST', `/pipelines/${pipeline.id}/stages/${retired.id}/restore`, {
      version: retired.version,
    });
    expect(response.status).toBe(422);
  });
});

describe('audit and events', () => {
  it('writes an audit entry and an outbox event for create, rename, reorder, retire and restore', async () => {
    const pipeline = await freshPipeline();
    const created = dataOf<Pipeline>(
      await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Audited stage' }),
      201,
    );
    const stage = stageNamed(created, 'Audited stage');
    dataOf(await patchStage(created, stage, { name: 'Audited and renamed', probability: 35 }), 200);
    const afterRename = await managed(pipeline.id);
    const ids = inUse(afterRename).map((entry) => entry.id);
    dataOf(
      await api('POST', `/pipelines/${pipeline.id}/stages/order`, {
        version: afterRename.version,
        stageIds: [ids[1]!, ids[0]!, ...ids.slice(2)],
      }),
      200,
    );
    const afterOrder = await managed(pipeline.id);
    dataOf(await archive(afterOrder, stageNamed(afterOrder, 'Audited and renamed')), 200);
    const afterArchive = await managed(pipeline.id);
    dataOf(
      await api('POST', `/pipelines/${pipeline.id}/stages/${stage.id}/restore`, {
        version: stageNamed(afterArchive, 'Audited and renamed').version,
      }),
      200,
    );

    const stageAudit = (await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).filter(
      (entry) => entry.recordId === stage.id,
    );
    expect(stageAudit.map((entry) => entry.action).sort()).toEqual([
      'create',
      'delete',
      'restore',
      'update',
    ]);
    const update = stageAudit.find((entry) => entry.action === 'update')!;
    expect(update.changes).toMatchObject({
      name: { old: 'Audited stage', new: 'Audited and renamed' },
      probability: { old: 50, new: 35 },
    });

    const pipelineAudit = (await harness.fixtures.auditEntries(tenantId, 'pipeline')).filter(
      (entry) => entry.recordId === pipeline.id,
    );
    expect(pipelineAudit.map((entry) => entry.action)).toEqual(['update']);

    for (const type of [
      'pipeline_stage.created.v1',
      'pipeline_stage.updated.v1',
      'pipeline_stage.archived.v1',
      'pipeline_stage.restored.v1',
    ]) {
      const events = (await harness.fixtures.outboxEvents(tenantId, type)).filter(
        (event) => event.recordId === stage.id,
      );
      expect(events, type).toHaveLength(1);
    }
    const reordered = (
      await harness.fixtures.outboxEvents(tenantId, 'pipeline.stages_reordered.v1')
    ).filter((event) => event.recordId === pipeline.id);
    expect(reordered).toHaveLength(1);
  });

  it('writes nothing when a request is refused', async () => {
    const pipeline = await freshPipeline();
    const before = (await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).length;
    expect(
      (await api('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Lead in' })).status,
    ).toBe(409);
    expect(
      (await patchStage(pipeline, stageNamed(pipeline, 'Lead in'), { probability: 500 })).status,
    ).toBe(422);
    expect((await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).length).toBe(before);
  });

  it('does not write an audit entry for a rename to the same name', async () => {
    const pipeline = await freshPipeline();
    const stage = stageNamed(pipeline, 'Lead in');
    const before = (await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).length;
    expect((await patchStage(pipeline, stage, { name: 'Lead in' })).status).toBe(200);
    expect((await harness.fixtures.auditEntries(tenantId, 'pipeline_stage')).length).toBe(before);
  });
});
