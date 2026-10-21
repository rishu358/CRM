import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The rep leaderboard (MVP_SPEC M10, ADR-0038), in a company of its own so that
 * the wins here are the only wins there are.
 */

interface Person {
  token: string;
  userId: string;
}
interface Row {
  userId: string;
  name: string;
  isYou: boolean;
  count: number;
  total: { amountMinor: string; currency: string } | null;
  partial: boolean;
}
interface Leaderboard {
  rankedBy: 'amount' | 'count';
  rows: Row[] | null;
}

const HOUR = 3_600_000;

let harness: ApiHarness;
let tenantId: string;
let pipelineId: string;
let stages: Record<string, string>;
let roles: ReadonlyMap<string, string>;
let admin: Person;
let ravi: Person;
let omar: Person;
let priya: Person;
let gone: Person;
let start: number;

async function newPerson(role: string, name: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roles.get(role)!, { name });
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

async function win(owner: Person, closedAt: Date, amountMinor: bigint, currency = 'INR') {
  await harness.fixtures.createDeal(tenantId, {
    pipelineId,
    stageId: stages['Won']!,
    ownerId: owner.userId,
    amountMinor,
    currency,
    probability: 100,
    closedAt,
  });
}

async function board(who: Person): Promise<Leaderboard> {
  const response = await request(harness, {
    method: 'GET',
    url: '/api/v1/dashboard/leaderboard',
    token: who.token,
  });
  return dataOf<Leaderboard>(response, 200);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Leaderboard Co' })).tenantId;
  roles = await harness.provision(tenantId);
  await harness.fixtures.setTenantTimeZone(tenantId, 'Asia/Kolkata');
  await harness.fixtures.setExchangeRate(tenantId, 'USD', 'INR', '83.25');

  admin = await newPerson('Admin', 'Asha Admin');
  ravi = await newPerson('Sales Rep', 'Ravi Rep');
  omar = await newPerson('Sales Rep', 'Omar Other');
  priya = await newPerson('Sales Rep', 'Priya Dollar');
  gone = await newPerson('Sales Rep', 'Gone Person');

  const main = (await harness.fixtures.pipelinesFor(tenantId)).find((p) => p.isDefault)!;
  pipelineId = main.id;
  stages = Object.fromEntries(main.stages.map((stage) => [stage.name, stage.id]));

  const window = dataOf<{ month: { start: string } }>(
    await request(harness, { method: 'GET', url: '/api/v1/dashboard/won', token: admin.token }),
    200,
  ).month;
  start = Date.parse(window.start);

  await win(ravi, new Date(start + HOUR), 400_000n);
  await win(ravi, new Date(start + 2 * HOUR), 300_000n);
  await win(omar, new Date(start + 3 * HOUR), 1_000_000n);
  await win(priya, new Date(start + 4 * HOUR), 10_000n, 'USD'); // 832,500 in rupees
  await win(gone, new Date(start + 5 * HOUR), 100_000n);
  await win(admin, new Date(start + 6 * HOUR), 50_000n, 'EUR'); // no rate exists
  // Last month does not count towards this month's table.
  await win(ravi, new Date(start - HOUR), 9_000_000n);

  await harness.fixtures.setMembershipStatus(tenantId, gone.userId, 'suspended');
});

afterAll(async () => {
  await harness.close();
});

describe('the leaderboard', () => {
  it('ranks by converted value this month, with the names the company knows people by', async () => {
    const data = await board(admin);
    expect(data.rankedBy).toBe('amount');
    expect(data.rows!.map((row) => [row.name, row.total?.amountMinor, row.count])).toEqual([
      ['Omar Other', '1000000', 1],
      ['Priya Dollar', '832500', 1],
      ['Ravi Rep', '700000', 2],
      ['Former member', '100000', 1],
      ['Asha Admin', '0', 1],
    ]);
  });

  it('marks a person whose deals could not all be converted, rather than ranking them as if complete', async () => {
    const data = await board(admin);
    expect(data.rows!.filter((row) => row.partial).map((row) => row.name)).toEqual(['Asha Admin']);
  });

  it('shows a rep with own scope only themselves, and none of the colleagues', async () => {
    const data = await board(ravi);
    expect(data.rows!.map((row) => row.name)).toEqual(['Ravi Rep']);
    expect(JSON.stringify(data)).not.toContain('Omar');
    expect(JSON.stringify(data)).not.toContain(omar.userId);
  });

  it("marks the caller's own row, and only that one", async () => {
    for (const who of [ravi, omar, admin]) {
      const data = await board(who);
      const mine = data.rows!.filter((row) => row.isYou);
      expect(mine.map((row) => row.userId)).toEqual([who.userId]);
    }
  });

  it('labels a person who has left the company neutrally, not by a stale or erased name', async () => {
    const data = await board(admin);
    const row = data.rows!.find((candidate) => candidate.userId === gone.userId)!;
    expect(row.name).toBe('Former member');
    expect(JSON.stringify(data)).not.toContain('Gone Person');
  });

  it('exposes no address, role or status of anybody', async () => {
    const data = await board(admin);
    for (const row of data.rows!) {
      expect(Object.keys(row).sort()).toEqual([
        'count',
        'isYou',
        'name',
        'partial',
        'total',
        'userId',
      ]);
    }
    expect(JSON.stringify(data)).not.toContain('@example.com');
  });

  it('shows ten people at most, and the ones cut are the smallest', async () => {
    for (let index = 0; index < 8; index += 1) {
      const person = await newPerson('Sales Rep', `Extra ${index}`);
      await win(person, new Date(start + 7 * HOUR), BigInt(1000 + index));
    }
    const data = await board(admin);
    expect(data.rows).toHaveLength(10);
    const values = data.rows!.map((row) => BigInt(row.total!.amountMinor));
    expect([...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(values);
    // Eleven or more people won something; Asha, with a total of zero, is the one left off.
    expect(data.rows!.some((row) => row.name === 'Asha Admin')).toBe(false);
  });
});
