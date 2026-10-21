import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10) for the
 * dashboard, plus what is specific to it: every figure on it is a sum or a count,
 * and a sum is the quietest way there is to read a field that was hidden or a
 * record that was out of scope (ADR-0038).
 *
 *   (a) tenant A cannot see tenant B's records in any figure
 *   (b) a user with `own` scope sees figures over their own records only
 *   (c) a hidden field cannot be read back as a total, a count or a grouping
 *   (d) unauthenticated requests get 401
 *   (e) a widget the caller may not read is refused alone, and the rest load
 *
 * Through the real HTTP stack, with the production guards, pipes and database
 * roles, because every one of them is part of what is being asserted.
 */

interface Person {
  token: string;
  userId: string;
}

const HOUR = 3_600_000;
const WIDGETS = [
  '/api/v1/dashboard/pipeline',
  '/api/v1/dashboard/won',
  '/api/v1/dashboard/leads-by-source',
  '/api/v1/dashboard/overdue-tasks',
  '/api/v1/dashboard/leaderboard',
] as const;

let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let repA: Person;
let otherRepA: Person;
let adminB: Person;
let pipelineA: string;
let pipelineB: string;
let stagesA: Record<string, string>;
let stagesB: Record<string, string>;
let monthStart: number;

// Numbers chosen so that none of them can appear in a payload by coincidence.
const A_ADMIN_DEAL = 5_123_457n;
const A_REP_DEAL = 1_234_567n;
const A_OTHER_REP_DEAL = 7_654_321n;
const A_WIN = 3_141_593n;
const B_DEAL = 9_876_543n;
const B_WIN = 8_642_097n;

async function person(tenantId: string, roleId: string, name: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roleId, { name });
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

function call(url: string, who: Person | null) {
  return request(harness, { method: 'GET', url, ...(who === null ? {} : { token: who.token }) });
}

async function body(url: string, who: Person): Promise<unknown> {
  return dataOf(await call(url, who), 200);
}

/** A role that reads everything the dashboard summarises, with some fields hidden. */
async function roleHiding(
  name: string,
  hidden: readonly (readonly [string, string])[],
): Promise<Person> {
  const roleId = await harness.fixtures.createRole(tenantA, name);
  for (const objectType of ['deal', 'lead', 'activity', 'contact', 'account']) {
    await harness.fixtures.grantAll(tenantA, roleId, objectType, 'all');
  }
  for (const [objectType, field] of hidden) {
    await harness.fixtures.setFieldPermission(tenantA, roleId, objectType, field, 'hidden');
  }
  return person(tenantA, roleId, name);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Dashboard' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Dashboard' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await person(tenantA, rolesA.get('Admin')!, 'Alice Acme');
  repA = await person(tenantA, rolesA.get('Sales Rep')!, 'Rita Rep');
  otherRepA = await person(tenantA, rolesA.get('Sales Rep')!, 'Oscar Other');
  adminB = await person(tenantB, rolesB.get('Admin')!, 'Bob Rival');

  const mainA = (await harness.fixtures.pipelinesFor(tenantA)).find((p) => p.isDefault)!;
  pipelineA = mainA.id;
  stagesA = Object.fromEntries(mainA.stages.map((stage) => [stage.name, stage.id]));
  const mainB = (await harness.fixtures.pipelinesFor(tenantB)).find((p) => p.isDefault)!;
  pipelineB = mainB.id;
  stagesB = Object.fromEntries(mainB.stages.map((stage) => [stage.name, stage.id]));

  await harness.fixtures.setTenantTimeZone(tenantA, 'UTC');
  await harness.fixtures.setTenantTimeZone(tenantB, 'UTC');
  const won = (await body('/api/v1/dashboard/won', adminA)) as { month: { start: string } };
  monthStart = Date.parse(won.month.start);

  const open = (
    tenantId: string,
    pipelineId: string,
    stages: Record<string, string>,
    owner: Person,
    amountMinor: bigint,
  ) =>
    harness.fixtures.createDeal(tenantId, {
      pipelineId,
      stageId: stages['New']!,
      ownerId: owner.userId,
      amountMinor,
      currency: 'INR',
    });
  const close = (
    tenantId: string,
    pipelineId: string,
    stages: Record<string, string>,
    owner: Person,
    amountMinor: bigint,
  ) =>
    harness.fixtures.createDeal(tenantId, {
      pipelineId,
      stageId: stages['Won']!,
      ownerId: owner.userId,
      amountMinor,
      currency: 'INR',
      probability: 100,
      closedAt: new Date(monthStart + 2 * HOUR),
    });

  await open(tenantA, pipelineA, stagesA, adminA, A_ADMIN_DEAL);
  await open(tenantA, pipelineA, stagesA, repA, A_REP_DEAL);
  await open(tenantA, pipelineA, stagesA, otherRepA, A_OTHER_REP_DEAL);
  await close(tenantA, pipelineA, stagesA, adminA, A_WIN);
  await close(tenantA, pipelineA, stagesA, repA, A_WIN + 1n);
  await open(tenantB, pipelineB, stagesB, adminB, B_DEAL);
  await close(tenantB, pipelineB, stagesB, adminB, B_WIN);

  await harness.fixtures.createLead(tenantA, { ownerId: adminA.userId, source: 'Acme source' });
  await harness.fixtures.createLead(tenantA, { ownerId: repA.userId, source: 'Rep source' });
  await harness.fixtures.createLead(tenantB, { ownerId: adminB.userId, source: 'Rival source' });

  const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
  await harness.fixtures.createActivity(tenantA, {
    assignedTo: adminA.userId,
    subject: 'Acme overdue',
    dueAt: ago(30),
  });
  await harness.fixtures.createActivity(tenantA, {
    assignedTo: repA.userId,
    subject: 'Rep overdue',
    dueAt: ago(30),
  });
  await harness.fixtures.createActivity(tenantB, {
    assignedTo: adminB.userId,
    subject: 'Rival overdue',
    dueAt: ago(30),
  });
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it.each(WIDGETS)('rejects %s with no credentials', async (url) => {
    expect((await call(url, null)).status).toBe(401);
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: WIDGETS[0],
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });
});

describe('(a) tenant isolation', () => {
  it("keeps the other company's records out of every figure, in both directions", async () => {
    const a = JSON.stringify(await Promise.all(WIDGETS.map((url) => body(url, adminA))));
    const b = JSON.stringify(await Promise.all(WIDGETS.map((url) => body(url, adminB))));

    for (const needle of [B_DEAL, B_WIN, 'Rival source', 'Rival overdue', 'Bob Rival']) {
      expect(a, String(needle)).not.toContain(String(needle));
    }
    for (const needle of [
      A_ADMIN_DEAL,
      A_REP_DEAL,
      A_WIN,
      'Acme source',
      'Acme overdue',
      'Alice',
    ]) {
      expect(b, String(needle)).not.toContain(String(needle));
    }
  });

  it("answers 404 for another company's pipeline, as it does for one that does not exist", async () => {
    const foreign = await call(`/api/v1/dashboard/pipeline?pipelineId=${pipelineB}`, adminA);
    const missing = await call(
      '/api/v1/dashboard/pipeline?pipelineId=0198f0f0-0000-7000-8000-000000000000',
      adminA,
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const reason = (response: { body: Record<string, unknown> }) => {
      const { code, message } = response.body['error'] as Record<string, unknown>;
      return { code, message };
    };
    expect(reason(foreign)).toEqual(reason(missing));
  });

  it('ignores a company named in a header, because the session decides', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/dashboard/leads-by-source',
      token: adminA.token,
      tenantId: tenantB,
    });
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('Rival source');
  });
});

describe('(b) a rep with own scope sees figures over their own records only', () => {
  it('totals only their own open deals, exactly as the board does for them', async () => {
    const data = (await body('/api/v1/dashboard/pipeline', repA)) as {
      open: { count: number; total: { amountMinor: string } };
    };
    expect(data.open.count).toBe(1);
    expect(data.open.total.amountMinor).toBe(String(A_REP_DEAL));

    const board = (await body('/api/v1/deals/board', repA)) as {
      columns: { stageId: string; count: number; total: { amountMinor: string } | null }[];
    };
    const boardNew = board.columns.find((column) => column.stageId === stagesA['New'])!;
    expect(boardNew.count).toBe(1);
    expect(boardNew.total?.amountMinor).toBe(String(A_REP_DEAL));
  });

  it("counts only their own wins, and none of a colleague's", async () => {
    const data = (await body('/api/v1/dashboard/won', repA)) as {
      current: { count: number; total: { amountMinor: string } };
    };
    expect(data.current.count).toBe(1);
    expect(data.current.total.amountMinor).toBe(String(A_WIN + 1n));
  });

  it('lists only the sources of their own leads, and only their own overdue tasks', async () => {
    const leads = JSON.stringify(await body('/api/v1/dashboard/leads-by-source', repA));
    expect(leads).toContain('Rep source');
    expect(leads).not.toContain('Acme source');

    const tasks = JSON.stringify(await body('/api/v1/dashboard/overdue-tasks', repA));
    expect(tasks).toContain('Rep overdue');
    expect(tasks).not.toContain('Acme overdue');
  });

  it('puts only themselves on the leaderboard', async () => {
    const data = (await body('/api/v1/dashboard/leaderboard', repA)) as {
      rows: { userId: string }[];
    };
    expect(data.rows.map((row) => row.userId)).toEqual([repA.userId]);
  });
});

describe('(c) a hidden field cannot be read back as a total, a count or a grouping', () => {
  it('gives counts and no money to a role that cannot read the amount', async () => {
    const who = await roleHiding('No amounts', [['deal', 'amount']]);

    const pipeline = (await body('/api/v1/dashboard/pipeline', who)) as {
      stages: { name: string; count: number; total: unknown }[];
      open: { count: number; total: unknown };
    };
    expect(pipeline.open.count).toBe(3);
    expect(pipeline.open.total).toBeNull();
    for (const stage of pipeline.stages) expect(stage.total, stage.name).toBeNull();
    expect(pipeline.stages.find((stage) => stage.name === 'New')?.count).toBe(3);

    const won = (await body('/api/v1/dashboard/won', who)) as {
      current: { count: number; total: unknown };
    };
    expect(won.current.count).toBe(2);
    expect(won.current.total).toBeNull();

    const board = (await body('/api/v1/dashboard/leaderboard', who)) as {
      rankedBy: string;
      rows: { total: unknown; count: number }[];
    };
    expect(board.rankedBy).toBe('count');
    for (const row of board.rows) expect(row.total).toBeNull();
  });

  it('never lets the hidden amount or its currency into any payload, whatever the widget', async () => {
    const who = await roleHiding('No amounts, again', [['deal', 'amount']]);
    const everything = JSON.stringify(await Promise.all(WIDGETS.map((url) => body(url, who))));
    for (const amount of [A_ADMIN_DEAL, A_REP_DEAL, A_OTHER_REP_DEAL, A_WIN, A_WIN + 1n]) {
      expect(everything, String(amount)).not.toContain(String(amount));
    }
    // The company's reporting currency is a fact about the company and is shown; what
    // would betray a hidden amount is a money value or a deal's currency, and neither exists.
    expect(everything).not.toContain('"amountMinor"');
    expect(everything).not.toContain('"total":{');
    expect(everything).not.toContain('"unconverted":[{');
  });

  it('gives nothing about wins to a role that cannot read when a deal closed', async () => {
    const who = await roleHiding('No close dates', [['deal', 'closed_at']]);
    const won = (await body('/api/v1/dashboard/won', who)) as {
      current: unknown;
      previous: unknown;
    };
    expect(won.current).toBeNull();
    expect(won.previous).toBeNull();
    const board = (await body('/api/v1/dashboard/leaderboard', who)) as { rows: unknown };
    expect(board.rows).toBeNull();
  });

  it('gives no leaderboard to a role that cannot read who owns a deal, since ranking by owner would tell it', async () => {
    const who = await roleHiding('No owners', [['deal', 'owner_id']]);
    const board = (await body('/api/v1/dashboard/leaderboard', who)) as { rows: unknown };
    expect(board.rows).toBeNull();
    expect(JSON.stringify(board)).not.toContain(adminA.userId);
  });

  it('refuses the pipeline to a role that cannot read which stage a deal is in', async () => {
    const who = await roleHiding('No stages', [['deal', 'stage_id']]);
    expect((await call('/api/v1/dashboard/pipeline', who)).status).toBe(403);
  });

  it('gives no breakdown to a role that cannot read the source, but still the number of leads', async () => {
    const who = await roleHiding('No sources', [['lead', 'source']]);
    const data = (await body('/api/v1/dashboard/leads-by-source', who)) as {
      total: number;
      sources: unknown;
    };
    expect(data.sources).toBeNull();
    expect(data.total).toBe(2);
    expect(JSON.stringify(data)).not.toContain('source"');
  });

  it('gives not even a total to a role that cannot read lead status, which the total is made of', async () => {
    const who = await roleHiding('No lead status', [['lead', 'status']]);
    const data = (await body('/api/v1/dashboard/leads-by-source', who)) as {
      total: unknown;
      sources: unknown;
    };
    expect(data.total).toBeNull();
    expect(data.sources).toBeNull();
  });

  it.each([['due_at'], ['status'], ['type']])(
    'gives no overdue count to a role that cannot read an activity %s',
    async (field) => {
      const who = await roleHiding(`No task ${field}`, [['activity', field]]);
      const data = (await body('/api/v1/dashboard/overdue-tasks', who)) as {
        count: unknown;
        items: unknown[];
      };
      expect(data.count).toBeNull();
      expect(data.items).toEqual([]);
    },
  );

  it('strips a hidden subject from the tasks it does list, as the activities list does', async () => {
    const who = await roleHiding('No subjects', [['activity', 'subject']]);
    const data = (await body('/api/v1/dashboard/overdue-tasks', who)) as {
      count: number;
      items: Record<string, unknown>[];
    };
    expect(data.count).toBe(2);
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) expect(item).not.toHaveProperty('subject');
    expect(JSON.stringify(data)).not.toContain('overdue');
  });
});

describe('(e) a widget the caller may not read is refused alone', () => {
  it('answers 403 for deals and still serves the widgets the role does grant', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Leads and tasks only');
    await harness.fixtures.grantAll(tenantA, roleId, 'lead', 'all');
    await harness.fixtures.grantAll(tenantA, roleId, 'activity', 'all');
    const who = await person(tenantA, roleId, 'Lena Leads');

    for (const url of [WIDGETS[0], WIDGETS[1], WIDGETS[4]]) {
      expect((await call(url, who)).status, url).toBe(403);
    }
    for (const url of [WIDGETS[2], WIDGETS[3]]) {
      expect((await call(url, who)).status, url).toBe(200);
    }
  });

  it('answers 403 for everything to a role with no grants at all, and says nothing about the data', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Nothing');
    const who = await person(tenantA, roleId, 'Nina Nothing');
    for (const url of WIDGETS) {
      const response = await call(url, who);
      expect(response.status, url).toBe(403);
      for (const amount of [A_ADMIN_DEAL, A_REP_DEAL, A_WIN, B_DEAL]) {
        expect(JSON.stringify(response.body)).not.toContain(String(amount));
      }
    }
  });

  it('takes the scope from the grant on each object: own deals, all leads', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, 'Mixed scopes');
    await harness.fixtures.grantAll(tenantA, roleId, 'deal', 'own');
    await harness.fixtures.grantAll(tenantA, roleId, 'lead', 'all');
    const who = await person(tenantA, roleId, 'Mixed Scopes');
    const pipeline = (await body('/api/v1/dashboard/pipeline', who)) as { open: { count: number } };
    expect(pipeline.open.count).toBe(0); // owns no deals
    const leads = (await body('/api/v1/dashboard/leads-by-source', who)) as { total: number };
    expect(leads.total).toBe(2); // sees every lead
  });
});

describe('what the dashboard will not take from the client', () => {
  it.each(['tenantId', 'userId', 'ownerId', 'amount'])(
    'rejects %s in the query string as an unknown key',
    async (key) => {
      const response = await call(`/api/v1/dashboard/pipeline?${key}=x`, adminA);
      expect(response.status).toBe(422);
    },
  );
});
