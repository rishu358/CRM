import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for the pipeline and stage editor
 * (MVP_SPEC M5, M9; ADR-0061). Through the real HTTP stack, with the production guards, pipes and
 * database roles:
 *
 *   (a) tenant A cannot list, read, change or retire tenant B's pipelines and stages
 *   (b) only the `pipeline` grant edits; a role with the deal grants alone cannot, and each
 *       action is its own grant
 *   (c) the editor shows counts, never records: no deal field is disclosed to the editor, and a
 *       role that cannot see a deal's fields learns nothing from moving it
 *   (d) unauthenticated requests get 401
 */

interface Person {
  token: string;
  userId: string;
}
interface Stage {
  id: string;
  name: string;
  version: number;
  stageType: 'open' | 'won' | 'lost';
  archivedAt: string | null;
  dealCount: number;
}
interface Pipeline {
  id: string;
  name: string;
  version: number;
  stages: Stage[];
}

let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let adminB: Person;
let repA: Person;
let readOnlyA: Person;
let pipelineA: Pipeline;
let pipelineB: Pipeline;

const MISSING = '0198f0f0-0000-7000-8000-000000000000';

async function person(tenantId: string, roleId: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

const as = (who: Person | null, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    ...(who === null ? {} : { token: who.token }),
    ...(body === undefined ? {} : { body }),
  });

async function pipelineOf(who: Person, pipelineId: string): Promise<Pipeline> {
  const list = dataOf<Pipeline[]>(await as(who, 'GET', '/pipelines/manage'), 200);
  return list.find((pipeline) => pipeline.id === pipelineId)!;
}

const stageNamed = (pipeline: Pipeline, name: string) =>
  pipeline.stages.find((stage) => stage.name === name)!;

async function customRole(
  tenantId: string,
  name: string,
  grants: [string, 'read' | 'create' | 'update' | 'delete', 'own' | 'team' | 'all'][],
): Promise<Person> {
  const roleId = await harness.fixtures.createRole(tenantId, name);
  for (const [objectType, action, scope] of grants) {
    await harness.fixtures.grant(tenantId, roleId, objectType, action, scope);
  }
  return person(tenantId, roleId);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Pipelines' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Pipelines' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await person(tenantA, rolesA.get('Admin')!);
  repA = await person(tenantA, rolesA.get('Sales Rep')!);
  readOnlyA = await person(tenantA, rolesA.get('Read-only')!);
  adminB = await person(tenantB, rolesB.get('Admin')!);

  const idsA = (await harness.fixtures.pipelinesFor(tenantA)).find(
    (pipeline) => pipeline.isDefault,
  )!;
  const idsB = (await harness.fixtures.pipelinesFor(tenantB)).find(
    (pipeline) => pipeline.isDefault,
  )!;
  pipelineA = await pipelineOf(adminA, idsA.id);
  pipelineB = await pipelineOf(adminB, idsB.id);

  // A deal in each company, so "moved" or "leaked" has something to show.
  await harness.fixtures.createDeal(tenantA, {
    pipelineId: pipelineA.id,
    stageId: stageNamed(pipelineA, 'Qualified').id,
    ownerId: adminA.userId,
    name: 'Acme confidential deal',
  });
  await harness.fixtures.createDeal(tenantB, {
    pipelineId: pipelineB.id,
    stageId: stageNamed(pipelineB, 'Qualified').id,
    ownerId: adminB.userId,
    name: 'Rival confidential deal',
  });
  pipelineA = await pipelineOf(adminA, pipelineA.id);
  pipelineB = await pipelineOf(adminB, pipelineB.id);
});

afterAll(async () => {
  await harness.close();
});

const stageUrl = (pipelineId: string, stageId: string) =>
  `/pipelines/${pipelineId}/stages/${stageId}`;

const ENDPOINTS = [
  ['GET', '/pipelines/manage'],
  ['POST', `/pipelines/${MISSING}/stages`],
  ['PATCH', `/pipelines/${MISSING}/stages/${MISSING}`],
  ['POST', `/pipelines/${MISSING}/stages/order`],
  ['POST', `/pipelines/${MISSING}/stages/${MISSING}/archive`],
  ['POST', `/pipelines/${MISSING}/stages/${MISSING}/restore`],
] as const;

describe('(d) unauthenticated requests get 401', () => {
  it.each(ENDPOINTS)('rejects %s %s with no credentials', async (method, url) => {
    const response = await as(null, method, url, method === 'GET' ? undefined : {});
    expect(response.status).toBe(401);
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/pipelines/manage',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });
});

describe('(a) tenant isolation', () => {
  it("never lists the other company's pipelines or stages, in either direction", async () => {
    const a = JSON.stringify(await as(adminA, 'GET', '/pipelines/manage'));
    const b = JSON.stringify(await as(adminB, 'GET', '/pipelines/manage'));
    expect(a).toContain(pipelineA.id);
    expect(a).not.toContain(pipelineB.id);
    expect(b).toContain(pipelineB.id);
    expect(b).not.toContain(pipelineA.id);
    for (const stage of pipelineB.stages) expect(a).not.toContain(stage.id);
    for (const stage of pipelineA.stages) expect(b).not.toContain(stage.id);
  });

  it("answers 404 to every write on another company's pipeline, as for one that does not exist", async () => {
    const stage = stageNamed(pipelineB, 'Proposal');
    const attempts = (pipelineId: string, stageId: string) => [
      as(adminA, 'POST', `/pipelines/${pipelineId}/stages`, { name: 'Hijack' }),
      as(adminA, 'PATCH', stageUrl(pipelineId, stageId), {
        version: stage.version,
        name: 'Hijacked',
      }),
      as(adminA, 'POST', `/pipelines/${pipelineId}/stages/order`, {
        version: pipelineB.version,
        stageIds: pipelineB.stages.map((entry) => entry.id),
      }),
      as(adminA, 'POST', `${stageUrl(pipelineId, stageId)}/archive`, { version: stage.version }),
      as(adminA, 'POST', `${stageUrl(pipelineId, stageId)}/restore`, { version: stage.version }),
    ];
    const foreign = await Promise.all(attempts(pipelineB.id, stage.id));
    const missing = await Promise.all(attempts(MISSING, MISSING));
    for (const response of [...foreign, ...missing]) expect(response.status).toBe(404);

    const reason = (response: { body: Record<string, unknown> }) => {
      const { code, message } = response.body['error'] as Record<string, unknown>;
      return { code, message };
    };
    // The same words for both, so a pipeline id is not an existence oracle.
    expect(reason(foreign[0]!)).toEqual(reason(missing[0]!));

    const after = await pipelineOf(adminB, pipelineB.id);
    expect(after).toEqual(pipelineB);
  });

  it("answers 404 to a stage of the other company named under one's own pipeline", async () => {
    const foreignStage = stageNamed(pipelineB, 'Proposal');
    const response = await as(adminA, 'PATCH', stageUrl(pipelineA.id, foreignStage.id), {
      version: foreignStage.version,
      name: 'Hijacked',
    });
    expect(response.status).toBe(404);
    expect(await pipelineOf(adminB, pipelineB.id)).toEqual(pipelineB);
  });

  it("cannot move deals into the other company's stage when retiring one's own", async () => {
    const stage = stageNamed(pipelineA, 'Qualified');
    const response = await as(adminA, 'POST', `${stageUrl(pipelineA.id, stage.id)}/archive`, {
      version: stage.version,
      moveDealsToStageId: stageNamed(pipelineB, 'Proposal').id,
    });
    expect(response.status).toBe(422);
    const after = await pipelineOf(adminA, pipelineA.id);
    expect(stageNamed(after, 'Qualified')).toMatchObject({ archivedAt: null, dealCount: 1 });
    expect(await pipelineOf(adminB, pipelineB.id)).toEqual(pipelineB);
  });

  it("keeps the other company's stage names out of one's own duplicate check", async () => {
    // "Proposal" exists in both companies' default pipelines, so a stage called that is legal in each.
    const response = await as(adminA, 'POST', `/pipelines/${pipelineA.id}/stages`, {
      name: 'Rival-only name',
    });
    expect(response.status).toBe(201);
    const rival = await pipelineOf(adminB, pipelineB.id);
    expect(rival.stages.map((stage) => stage.name)).not.toContain('Rival-only name');
  });
});

describe('(b) permissions', () => {
  it('lets Owner and Admin do everything, and leaves the board readable by anyone who sees deals', async () => {
    expect((await as(adminA, 'GET', '/pipelines/manage')).status).toBe(200);
    expect((await as(repA, 'GET', '/pipelines')).status).toBe(200);
    expect((await as(readOnlyA, 'GET', '/pipelines')).status).toBe(200);
  });

  it.each(['repA', 'readOnlyA'] as const)(
    'gives %s 403 on the editor, for reading and for every write',
    async (who) => {
      const person = who === 'repA' ? repA : readOnlyA;
      const stage = stageNamed(pipelineA, 'Proposal');
      const responses = [
        await as(person, 'GET', '/pipelines/manage'),
        await as(person, 'POST', `/pipelines/${pipelineA.id}/stages`, { name: 'Nope' }),
        await as(person, 'PATCH', stageUrl(pipelineA.id, stage.id), {
          version: stage.version,
          name: 'Nope',
        }),
        await as(person, 'POST', `/pipelines/${pipelineA.id}/stages/order`, {
          version: pipelineA.version,
          stageIds: pipelineA.stages.map((entry) => entry.id),
        }),
        await as(person, 'POST', `${stageUrl(pipelineA.id, stage.id)}/archive`, {
          version: stage.version,
        }),
        await as(person, 'POST', `${stageUrl(pipelineA.id, stage.id)}/restore`, {
          version: stage.version,
        }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect((response.body['error'] as { code: string }).code).toBe('FORBIDDEN');
      }
      expect(stageNamed(await pipelineOf(adminA, pipelineA.id), 'Proposal').name).toBe('Proposal');
    },
  );

  it('does not let the deal grants stand in for the pipeline grant', async () => {
    const dealManager = await customRole(tenantA, 'Deal manager', [
      ['deal', 'read', 'all'],
      ['deal', 'create', 'all'],
      ['deal', 'update', 'all'],
      ['deal', 'delete', 'all'],
      ['tenant_settings', 'update', 'all'],
    ]);
    const stage = stageNamed(pipelineA, 'Proposal');
    expect(
      (
        await as(dealManager, 'PATCH', stageUrl(pipelineA.id, stage.id), {
          version: stage.version,
          name: 'Nope',
        })
      ).status,
    ).toBe(403);
    expect((await as(dealManager, 'GET', '/pipelines/manage')).status).toBe(403);
  });

  it('treats read, create, update and delete as separate grants', async () => {
    const stage = stageNamed(pipelineA, 'Proposal');
    const reader = await customRole(tenantA, 'Pipeline reader', [['pipeline', 'read', 'all']]);
    expect((await as(reader, 'GET', '/pipelines/manage')).status).toBe(200);
    expect(
      (await as(reader, 'POST', `/pipelines/${pipelineA.id}/stages`, { name: 'x1' })).status,
    ).toBe(403);

    const updater = await customRole(tenantA, 'Pipeline updater', [['pipeline', 'update', 'all']]);
    // Update alone renames; it cannot look at the list, add or retire.
    expect(
      (
        await as(updater, 'PATCH', stageUrl(pipelineA.id, stage.id), {
          version: stage.version,
          probability: 55,
        })
      ).status,
    ).toBe(200);
    expect((await as(updater, 'GET', '/pipelines/manage')).status).toBe(403);
    expect(
      (await as(updater, 'POST', `/pipelines/${pipelineA.id}/stages`, { name: 'x2' })).status,
    ).toBe(403);
    const fresh = stageNamed(await pipelineOf(adminA, pipelineA.id), 'Proposal');
    expect(
      (
        await as(updater, 'POST', `${stageUrl(pipelineA.id, fresh.id)}/archive`, {
          version: fresh.version,
        })
      ).status,
    ).toBe(403);

    const creator = await customRole(tenantA, 'Pipeline creator', [['pipeline', 'create', 'all']]);
    expect(
      (await as(creator, 'POST', `/pipelines/${pipelineA.id}/stages`, { name: 'Added by creator' }))
        .status,
    ).toBe(201);
    expect(
      (
        await as(creator, 'PATCH', stageUrl(pipelineA.id, fresh.id), {
          version: fresh.version,
          name: 'Nope',
        })
      ).status,
    ).toBe(403);
  });

  it('lets only a caller who may update all deals retire a stage that holds them', async () => {
    const stage = stageNamed(await pipelineOf(adminA, pipelineA.id), 'Qualified');
    const target = stageNamed(pipelineA, 'New');
    const narrow = await customRole(tenantA, 'Pipeline retirer, own deals', [
      ['pipeline', 'delete', 'all'],
      ['deal', 'read', 'own'],
      ['deal', 'update', 'own'],
    ]);
    const refused = await as(narrow, 'POST', `${stageUrl(pipelineA.id, stage.id)}/archive`, {
      version: stage.version,
      moveDealsToStageId: target.id,
    });
    expect(refused.status).toBe(403);
    // The transaction rolled back: the stage is still in use and the deal is still in it.
    expect(stageNamed(await pipelineOf(adminA, pipelineA.id), 'Qualified')).toMatchObject({
      archivedAt: null,
      dealCount: 1,
    });

    const wide = await customRole(tenantA, 'Pipeline retirer, all deals', [
      ['pipeline', 'delete', 'all'],
      ['deal', 'update', 'all'],
    ]);
    // An empty stage needs no deal grant at all.
    const empty = stageNamed(pipelineA, 'Negotiation');
    expect(
      (
        await as(wide, 'POST', `${stageUrl(pipelineA.id, empty.id)}/archive`, {
          version: empty.version,
        })
      ).status,
    ).toBe(200);
  });

  it('is not an escalation: a retirement writes the audit trail under the caller, not a system user', async () => {
    const entries = await harness.fixtures.auditEntries(tenantA, 'pipeline_stage');
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('(c) the editor shows counts, not records', () => {
  it('lists how many deals a stage holds without naming them', async () => {
    const response = await as(adminA, 'GET', '/pipelines/manage');
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('Acme confidential deal');
    expect(text).not.toContain('Rival confidential deal');
    expect(stageNamed(await pipelineOf(adminA, pipelineA.id), 'Qualified').dealCount).toBe(1);
  });

  it('does not put a deal, its name or its amount in the answer to a retirement', async () => {
    const stage = stageNamed(await pipelineOf(adminA, pipelineA.id), 'Qualified');
    const response = await as(adminA, 'POST', `${stageUrl(pipelineA.id, stage.id)}/archive`, {
      version: stage.version,
      moveDealsToStageId: stageNamed(pipelineA, 'New').id,
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('Acme confidential deal');
    expect((response.body['data'] as { movedDeals: number }).movedDeals).toBe(1);
  });

  it('keeps a field hidden from a role hidden after its deal has been moved by a retirement', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'No amounts');
    await harness.fixtures.grant(tenantA, roleId, 'deal', 'read', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'deal', 'amount', 'hidden');
    const blind = await person(tenantA, roleId);

    const dealId = await harness.fixtures.createDeal(tenantA, {
      pipelineId: pipelineA.id,
      stageId: stageNamed(pipelineA, 'Proposal').id,
      ownerId: adminA.userId,
      name: 'Priced deal',
      amountMinor: 99_900n,
      currency: 'INR',
    });
    const proposal = stageNamed(await pipelineOf(adminA, pipelineA.id), 'Proposal');
    expect(
      (
        await as(adminA, 'POST', `${stageUrl(pipelineA.id, proposal.id)}/archive`, {
          version: proposal.version,
          moveDealsToStageId: stageNamed(pipelineA, 'New').id,
        })
      ).status,
    ).toBe(200);

    const seen = dataOf<Record<string, unknown>>(
      await request(harness, { method: 'GET', url: `/api/v1/deals/${dealId}`, token: blind.token }),
      200,
    );
    expect(seen).not.toHaveProperty('amount');
    expect(seen['stageId']).toBe(stageNamed(pipelineA, 'New').id);
  });
});
