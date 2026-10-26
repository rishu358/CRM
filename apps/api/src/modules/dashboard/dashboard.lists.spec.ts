import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Leads by source and overdue tasks (MVP_SPEC M10, ADR-0038), each checked
 * against the list endpoint of the same records.
 */

interface Person {
  token: string;
  userId: string;
}
interface Sources {
  total: number | null;
  sources: { source: string | null; count: number }[] | null;
  otherCount: number;
}
interface Overdue {
  count: number | null;
  items: { id: string; subject?: string; dueAt?: string }[];
}

const HOUR = 3_600_000;

let harness: ApiHarness;
let tenantId: string;
let admin: Person;
let rep: Person;
let otherRep: Person;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Dashboard Lists Co' })).tenantId;
  const roles = await harness.provision(tenantId);
  const person = async (role: string): Promise<Person> => {
    const user = await harness.fixtures.createUser(tenantId, roles.get(role)!);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  admin = await person('Admin');
  rep = await person('Sales Rep');
  otherRep = await person('Sales Rep');
});

afterAll(async () => {
  await harness.close();
});

async function get<T>(url: string, who: Person = admin): Promise<T> {
  return dataOf<T>(await request(harness, { method: 'GET', url, token: who.token }), 200);
}

async function remove(path: string): Promise<void> {
  const response = await request(harness, {
    method: 'DELETE',
    url: `${path}?version=1`,
    token: admin.token,
  });
  expect(response.status).toBe(204);
}

describe('open leads by source', () => {
  let toDelete: string;

  beforeAll(async () => {
    const lead = (source: string | null, converted = false) =>
      harness.fixtures.createLead(tenantId, {
        ownerId: admin.userId,
        source,
        ...(converted ? { status: 'converted' as const, convertedAt: new Date() } : {}),
      });

    // One source typed three ways, as people do.
    await lead('Website');
    await lead('website ');
    await lead('  WEBSITE');
    await lead('Referral');
    await lead('Referral');
    // No source, and a blank one: the same thing.
    await lead(null);
    await lead('   ');
    await lead('Website', true);
    toDelete = await lead('Referral');
  });

  it('groups sources without regard to case or stray spaces, and counts a blank as none', async () => {
    const groups = (await get<Sources>('/api/v1/dashboard/leads-by-source')).sources!;
    expect(groups.filter((group) => group.source?.toLowerCase() === 'website')).toEqual([
      expect.objectContaining({ count: 3 }),
    ]);
    expect(groups.find((group) => group.source === 'Referral')?.count).toBe(3);
    expect(groups.find((group) => group.source === null)?.count).toBe(2);
  });

  it('leaves a converted lead out, and a deleted one', async () => {
    const before = await get<Sources>('/api/v1/dashboard/leads-by-source');
    expect(before.total).toBe(8); // 3 + 3 + 2, and not the converted one

    await remove(`/api/v1/leads/${toDelete}`);
    const after = await get<Sources>('/api/v1/dashboard/leads-by-source');
    expect(after.total).toBe(7);
    expect(after.sources!.find((group) => group.source === 'Referral')?.count).toBe(2);
  });

  it('adds up to what the leads list shows for every lead that is not converted', async () => {
    const data = await get<Sources>('/api/v1/dashboard/leads-by-source');
    const list = await get<unknown[]>('/api/v1/leads?limit=100&filter=status:neq:converted');
    expect(data.total).toBe(list.length);
    const shown = data.sources!.reduce((sum, group) => sum + group.count, 0);
    expect(shown + data.otherCount).toBe(data.total);
  });

  it('names the eight biggest sources and folds the rest into one number, so the rows still add up', async () => {
    for (let index = 1; index <= 10; index += 1) {
      await harness.fixtures.createLead(tenantId, {
        ownerId: admin.userId,
        source: `Campaign ${String(index).padStart(2, '0')}`,
      });
    }
    const data = await get<Sources>('/api/v1/dashboard/leads-by-source');
    expect(data.sources).toHaveLength(8);
    expect(data.total).toBe(17);
    expect(data.sources!.reduce((sum, group) => sum + group.count, 0) + data.otherCount).toBe(17);
    const counts = data.sources!.map((group) => group.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('shows a rep with own scope the sources of their own leads only', async () => {
    await harness.fixtures.createLead(tenantId, { ownerId: rep.userId, source: 'Trade fair' });
    const data = await get<Sources>('/api/v1/dashboard/leads-by-source', rep);
    expect(data.total).toBe(1);
    expect(data.sources).toEqual([{ source: 'Trade fair', count: 1 }]);
  });
});

describe('overdue tasks', () => {
  const ago = (hours: number): Date => new Date(Date.now() - hours * HOUR);
  let oldest: string;

  beforeAll(async () => {
    const task = (options: Parameters<ApiHarness['fixtures']['createActivity']>[1]) =>
      harness.fixtures.createActivity(tenantId, options);

    oldest = await task({ assignedTo: admin.userId, subject: 'Oldest', dueAt: ago(24 * 9) });
    await task({ assignedTo: rep.userId, subject: 'Second oldest', dueAt: ago(24 * 6) });
    await task({ assignedTo: admin.userId, subject: 'Third', dueAt: ago(24 * 3) });
    await task({ assignedTo: rep.userId, subject: 'Fourth', dueAt: ago(24) });
    await task({ assignedTo: otherRep.userId, subject: 'Fifth', dueAt: ago(5) });
    await task({ assignedTo: otherRep.userId, subject: 'Sixth', dueAt: ago(2) });
    // None of these is an overdue task.
    await task({
      assignedTo: admin.userId,
      subject: 'Done',
      dueAt: ago(48),
      status: 'completed',
      completedAt: ago(40),
    });
    await task({
      assignedTo: admin.userId,
      subject: 'Dropped',
      dueAt: ago(48),
      status: 'cancelled',
    });
    await task({ assignedTo: admin.userId, subject: 'Not yet', dueAt: ago(-48) });
    await task({ assignedTo: admin.userId, subject: 'No date' });
    await task({ assignedTo: admin.userId, subject: 'A call', dueAt: ago(48), type: 'call' });
  });

  it('counts every open task past its due time, and lists only the oldest five, oldest first', async () => {
    const data = await get<Overdue>('/api/v1/dashboard/overdue-tasks');
    expect(data.count).toBe(6);
    expect(data.items.map((item) => item.subject)).toEqual([
      'Oldest',
      'Second oldest',
      'Third',
      'Fourth',
      'Fifth',
    ]);
    expect(data.items[0]?.id).toBe(oldest);
  });

  it('matches the activities list filtered to the same thing', async () => {
    const data = await get<Overdue>('/api/v1/dashboard/overdue-tasks');
    const now = new Date().toISOString();
    const list = await get<unknown[]>(
      `/api/v1/activities?limit=100&status=open&filter=type:eq:task&filter=due_at:lt:${now}`,
    );
    expect(list).toHaveLength(data.count!);
  });

  it('shows a rep with own scope only the tasks assigned to them', async () => {
    const data = await get<Overdue>('/api/v1/dashboard/overdue-tasks', rep);
    expect(data.count).toBe(2);
    expect(data.items.map((item) => item.subject)).toEqual(['Second oldest', 'Fourth']);
  });

  it('drops a task from the count when it is deleted', async () => {
    await remove(`/api/v1/activities/${oldest}`);
    const data = await get<Overdue>('/api/v1/dashboard/overdue-tasks');
    expect(data.count).toBe(5);
    expect(data.items[0]?.subject).toBe('Second oldest');
  });
});
