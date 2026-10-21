import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the dashboard (MVP_SPEC M10, ADR-0038).
 *
 * Every figure here is checked two ways where it can be: against a number worked
 * out by hand from the fixtures, and against what the list or board endpoint of
 * the same records says. The second matters more. The dashboard writes no rule
 * of its own about who sees what, so the claim worth proving is that it never
 * adds up to something the lists would not.
 *
 * Time-based fixtures sit an hour or more from every boundary, so the database
 * clock and this process's clock disagreeing by seconds (they do, under Docker)
 * cannot move a record across a line.
 */

interface Person {
  token: string;
  userId: string;
}

let harness: ApiHarness;
let tenantId: string;
let admin: Person;
let rep: Person;
let stages: Record<string, string>;
let pipelineId: string;

const HOUR = 3_600_000;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Dashboard Behaviour Co' })).tenantId;
  const roles = await harness.provision(tenantId);

  const person = async (role: string, name: string): Promise<Person> => {
    const user = await harness.fixtures.createUser(tenantId, roles.get(role)!, { name });
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  admin = await person('Admin', 'Asha Admin');
  rep = await person('Sales Rep', 'Ravi Rep');

  const main = (await harness.fixtures.pipelinesFor(tenantId)).find((p) => p.isDefault)!;
  pipelineId = main.id;
  stages = Object.fromEntries(main.stages.map((stage) => [stage.name, stage.id]));

  await harness.fixtures.setTenantTimeZone(tenantId, 'Asia/Kolkata');
  await harness.fixtures.setExchangeRate(tenantId, 'USD', 'INR', '83.25');
});

afterAll(async () => {
  await harness.close();
});

function get<T>(url: string, who: Person = admin): Promise<T> {
  return request(harness, { method: 'GET', url, token: who.token }).then((response) =>
    dataOf<T>(response, 200),
  );
}

interface Money {
  amountMinor: string;
  currency: string;
}
interface Total {
  count: number;
  total: Money | null;
  unconverted: { currency: string; count: number; amountMinor: string }[];
}
interface Pipeline {
  pipelineId: string;
  currency: string;
  stages: { stageId: string; name: string; count: number; total: Money | null }[];
  open: Total;
}
interface Won {
  currency: string;
  timeZone: string;
  month: { start: string; end: string };
  current: Total | null;
  previous: Total | null;
}
interface Board {
  columns: { stageId: string; count: number; total: Money | null }[];
}

describe('pipeline value by stage', () => {
  let usdDeal: string;

  beforeAll(async () => {
    const make = (stage: string, amountMinor: bigint, currency: string, owner: Person) =>
      harness.fixtures.createDeal(tenantId, {
        pipelineId,
        stageId: stages[stage]!,
        ownerId: owner.userId,
        amountMinor,
        currency,
      });
    await make('New', 500_000n, 'INR', admin);
    usdDeal = await make('New', 10_000n, 'USD', rep);
    await make('Qualified', 250_000n, 'INR', rep);
    await make('Proposal', 90_000n, 'EUR', admin); // no EUR rate exists
    // A won deal is not pipeline.
    await harness.fixtures.createDeal(tenantId, {
      pipelineId,
      stageId: stages['Won']!,
      ownerId: admin.userId,
      amountMinor: 7_000_000n,
      currency: 'INR',
      probability: 100,
      closedAt: new Date('2020-01-15T10:00:00Z'),
    });
  });

  it('lists the open stages in order and leaves the closed ones out', async () => {
    const data = await get<Pipeline>('/api/v1/dashboard/pipeline');
    expect(data.pipelineId).toBe(pipelineId);
    expect(data.stages.map((stage) => stage.name)).toEqual([
      'New',
      'Qualified',
      'Proposal',
      'Negotiation',
    ]);
  });

  it('converts each currency once into the company currency, and says what it could not convert', async () => {
    const data = await get<Pipeline>('/api/v1/dashboard/pipeline');
    const byName = Object.fromEntries(data.stages.map((stage) => [stage.name, stage]));

    // 500,000 + 10,000 USD cents x 83.25 = 500,000 + 832,500
    expect(byName['New']).toMatchObject({
      count: 2,
      total: { amountMinor: '1332500', currency: 'INR' },
    });
    expect(byName['Qualified']?.total?.amountMinor).toBe('250000');
    expect(byName['Negotiation']).toMatchObject({ count: 0 });

    // The euro deal is counted, left out of the sum, and named — never silently short.
    const proposal = data.stages.find((stage) => stage.name === 'Proposal')!;
    expect(proposal.count).toBe(1);
    expect(proposal.total?.amountMinor).toBe('0');
    expect(data.open.unconverted).toEqual([{ currency: 'EUR', count: 1, amountMinor: '90000' }]);
    expect(data.open.count).toBe(4);
    expect(data.open.total?.amountMinor).toBe('1582500');
  });

  it('agrees with the Kanban board column for column', async () => {
    const data = await get<Pipeline>('/api/v1/dashboard/pipeline');
    const board = await get<Board>('/api/v1/deals/board');
    for (const stage of data.stages) {
      const column = board.columns.find((candidate) => candidate.stageId === stage.stageId)!;
      expect(stage.count, stage.name).toBe(column.count);
      expect(stage.total, stage.name).toEqual(column.total);
    }
  });

  it('stops counting a deal once it is deleted', async () => {
    const before = await get<Pipeline>('/api/v1/dashboard/pipeline');
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/deals/${usdDeal}?version=1`,
      token: admin.token,
    });
    expect(response.status).toBe(204);
    const after = await get<Pipeline>('/api/v1/dashboard/pipeline');
    expect(after.open.count).toBe(before.open.count - 1);
    expect(after.stages.find((s) => s.name === 'New')?.total?.amountMinor).toBe('500000');
  });

  it('refuses a malformed or unknown pipeline instead of falling back to the default', async () => {
    const malformed = await request(harness, {
      method: 'GET',
      url: '/api/v1/dashboard/pipeline?pipelineId=not-a-uuid',
      token: admin.token,
    });
    expect(malformed.status).toBe(422);
    const unknown = await request(harness, {
      method: 'GET',
      url: '/api/v1/dashboard/pipeline?pipelineId=0198f0f0-0000-7000-8000-000000000000',
      token: admin.token,
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects a query naming a tenant, which the session already decides', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/dashboard/pipeline?tenantId=${tenantId}`,
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });
});

describe("the company's month", () => {
  /** What a clock in `timeZone` reads at an instant, to the minute. */
  function localParts(instant: string, timeZone: string): Record<string, string> {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  it.each(['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])(
    'starts and ends on midnight of the first of the month in %s',
    async (timeZone) => {
      await harness.fixtures.setTenantTimeZone(tenantId, timeZone);
      const data = await get<Won>('/api/v1/dashboard/won');
      expect(data.timeZone).toBe(timeZone);

      const start = localParts(data.month.start, timeZone);
      const end = localParts(data.month.end, timeZone);
      expect(start).toMatchObject({ day: '01', hour: '00', minute: '00', second: '00' });
      expect(end).toMatchObject({ day: '01', hour: '00', minute: '00', second: '00' });

      // And it is the month that contains now: a window a month off would pass the
      // midnight checks above and be wrong.
      const now = Date.now();
      expect(Date.parse(data.month.start)).toBeLessThanOrEqual(now + 60_000);
      expect(Date.parse(data.month.end)).toBeGreaterThan(now - 60_000);
      const days = (Date.parse(data.month.end) - Date.parse(data.month.start)) / (24 * HOUR);
      expect(days).toBeGreaterThanOrEqual(27.9);
      expect(days).toBeLessThanOrEqual(31.1);
    },
  );

  it('falls back to UTC for a stored zone the runtime does not know, rather than failing', async () => {
    await harness.fixtures.setTenantTimeZone(tenantId, 'Mars/Olympus_Mons');
    const data = await get<Won>('/api/v1/dashboard/won');
    expect(data.timeZone).toBe('UTC');
    await harness.fixtures.setTenantTimeZone(tenantId, 'Asia/Kolkata');
  });
});

describe('deals won this month', () => {
  let ids: { thisMonth: string; lastMonth: string };

  async function close(
    owner: Person,
    closedAt: Date,
    amountMinor: bigint,
    currency = 'INR',
    stage: 'Won' | 'Lost' = 'Won',
  ): Promise<string> {
    return harness.fixtures.createDeal(tenantId, {
      pipelineId,
      stageId: stages[stage]!,
      ownerId: owner.userId,
      amountMinor,
      currency,
      probability: stage === 'Won' ? 100 : 0,
      closedAt,
      lostReason: stage === 'Lost' ? 'Price' : null,
    });
  }

  beforeAll(async () => {
    const window = (await get<Won>('/api/v1/dashboard/won')).month;
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);

    // This month: three wins, one of them in dollars.
    const thisMonth = await close(admin, new Date(start + HOUR), 1_000_000n);
    await close(rep, new Date(start + 2 * HOUR), 400_000n);
    await close(rep, new Date(start + 3 * HOUR), 10_000n, 'USD');
    // Last month: two wins, at both ends of it.
    const lastMonth = await close(admin, new Date(start - HOUR), 300_000n);
    await close(rep, new Date(start - 25 * 24 * HOUR), 50_000n);
    // Neither: two months ago, and after this month has ended.
    await close(admin, new Date(start - 70 * 24 * HOUR), 9_999_999n);
    await close(admin, new Date(end + HOUR), 8_888_888n);
    // A lost deal closed this month is not a win.
    await close(admin, new Date(start + HOUR), 777n, 'INR', 'Lost');

    ids = { thisMonth, lastMonth };
  });

  it('counts and totals this month and last, and nothing from outside them', async () => {
    const data = await get<Won>('/api/v1/dashboard/won');
    // 1,000,000 + 400,000 + (10,000 USD cents x 83.25 = 832,500)
    expect(data.current).toMatchObject({
      count: 3,
      total: { amountMinor: '2232500', currency: 'INR' },
      unconverted: [],
    });
    expect(data.previous).toMatchObject({
      count: 2,
      total: { amountMinor: '350000', currency: 'INR' },
    });
  });

  it('stops counting a win when it is deleted, in whichever month it fell', async () => {
    for (const [id, month, count] of [
      [ids.thisMonth, 'current', 2],
      [ids.lastMonth, 'previous', 1],
    ] as const) {
      const response = await request(harness, {
        method: 'DELETE',
        url: `/api/v1/deals/${id}?version=1`,
        token: admin.token,
      });
      expect(response.status).toBe(204);
      const data = await get<Won>('/api/v1/dashboard/won');
      expect(data[month]?.count, month).toBe(count);
    }
  });
});
