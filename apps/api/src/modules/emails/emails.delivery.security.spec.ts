import { randomUUID } from 'node:crypto';
import { emailSuppressionKey } from '@crm/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for blocked addresses and the pause (ADR-0075):
 *
 *   (a) tenant A cannot see, lift or resume anything of tenant B, and a block in B does not touch A
 *   (b) only whoever manages company settings may look at or change them; a rep and a Read-only role cannot
 *   (c) nothing in a request can name a company, a person or a reason; no address appears where it must not
 *   (d) unauthenticated requests get 401
 */

interface Person {
  token: string;
  userId: string;
}
interface Suppression {
  id: string;
  reason: string;
}

let harness: ApiHarness;
let superuser: pg.Pool;

let tenantA: string;
let adminA: Person;
let repA: Person;
let readOnlyA: Person;
let contactA: string;

let tenantB: string;
let adminB: Person;
let blockB: string;
let complaintB: string;

const call = (
  token: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) => request(harness, { method, url: `/api/v1${url}`, token, body });

async function block(tenant: string, address: string, reason: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `insert into email_suppressions (id, tenant_id, address_hash, reason) values ($1, $2, $3, $4)`,
    [id, tenant, emailSuppressionKey(tenant, address), reason],
  );
  return id;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { EMAIL_OUTREACH_FROM: 'mail@send.example' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  const make = async (tenantId: string, roleId: string) => {
    const user = await harness.fixtures.createUser(tenantId, roleId);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  adminA = await make(tenantA, rolesA.get('Admin')!);
  repA = await make(tenantA, rolesA.get('Sales Rep')!);
  readOnlyA = await make(tenantA, rolesA.get('Read-only')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);

  contactA = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Shared',
    email: 'shared@customer.example',
  });
  // The same address is blocked in the rival company, and must not be blocked here.
  blockB = await block(tenantB, 'shared@customer.example', 'hard_bounce');
  complaintB = await block(tenantB, 'angry@customer.example', 'complaint');
  await superuser.query(
    `insert into email_pauses (id, tenant_id, reason) values ($1, $2, 'bounces')`,
    [randomUUID(), tenantB],
  );
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes' where tenant_id = $1`,
    [tenantA],
  );
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every blocked-address and pause route with no credentials, or a made-up token', async () => {
    const id = crypto.randomUUID();
    const routes = [
      { method: 'GET', url: '/email-suppressions' },
      { method: 'POST', url: `/email-suppressions/${id}/lift` },
      { method: 'POST', url: '/email-pause/resume' },
    ] as const;
    for (const route of routes) {
      expect((await call(undefined, route.method, route.url)).status, route.url).toBe(401);
      expect(
        (await call('not-a-real-session-token-but-long-enough', route.method, route.url)).status,
        route.url,
      ).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('never lists, lifts or even hints at another company’s blocked addresses', async () => {
    const mine = dataOf<Suppression[]>(await call(adminA.token, 'GET', '/email-suppressions'));
    expect(mine.map((entry) => entry.id)).not.toContain(blockB);
    expect(mine.map((entry) => entry.id)).not.toContain(complaintB);

    for (const id of [blockB, complaintB, crypto.randomUUID()]) {
      // The same plain 404 for B's block as for one that never existed, so ids cannot be probed.
      expect((await call(adminA.token, 'POST', `/email-suppressions/${id}/lift`)).status, id).toBe(
        404,
      );
    }
    const theirs = dataOf<Suppression[]>(await call(adminB.token, 'GET', '/email-suppressions'));
    expect(theirs.map((entry) => entry.id).sort()).toEqual([blockB, complaintB].sort());
  });

  it('does not let a block in one company stop the same address in another', async () => {
    const response = await call(repA.token, 'POST', '/emails', {
      objectType: 'contact',
      recordId: contactA,
      subject: 'Hello',
      body: 'Hi',
    });
    expect(response.status).toBe(202);
    const context = dataOf<{ suppressed: unknown; paused: boolean }>(
      await call(repA.token, 'GET', `/emails/context?objectType=contact&recordId=${contactA}`),
    );
    expect(context.suppressed).toBeNull();
    expect(context.paused).toBe(false);
  });

  it('does not let one company resume another’s pause, or learn that it is paused', async () => {
    // Company A is not paused, so the answer is the plain "not paused", the same whatever B is doing.
    expect((await call(adminA.token, 'POST', '/email-pause/resume')).status).toBe(409);
    const stillPaused = dataOf<{ paused: unknown }>(
      await call(adminB.token, 'GET', '/email-settings'),
    );
    expect(stillPaused.paused).not.toBeNull();
    expect(
      dataOf<{ paused: unknown }>(await call(adminA.token, 'GET', '/email-settings')).paused,
    ).toBeNull();
  });
});

describe('(b) who may look and change', () => {
  it('refuses a rep and a Read-only role every one of the routes', async () => {
    const id = crypto.randomUUID();
    for (const person of [repA, readOnlyA]) {
      expect((await call(person.token, 'GET', '/email-suppressions')).status).toBe(403);
      expect((await call(person.token, 'POST', `/email-suppressions/${id}/lift`)).status).toBe(403);
      expect((await call(person.token, 'POST', '/email-pause/resume')).status).toBe(403);
    }
  });

  it('leaves a block and a pause as they were after a refused attempt', async () => {
    const mine = await block(tenantA, 'keep@customer.example', 'hard_bounce');
    expect((await call(repA.token, 'POST', `/email-suppressions/${mine}/lift`)).status).toBe(403);
    const row = await superuser.query<{ lifted_at: Date | null }>(
      `select lifted_at from email_suppressions where id = $1`,
      [mine],
    );
    expect(row.rows[0]!.lifted_at).toBeNull();
  });
});

describe('(c) what a request may not say, and what must not leak', () => {
  it('takes nothing from the request that could name a company, a person or a reason', async () => {
    // The routes have no body and no query: whatever is sent is not read, and the company is the session’s.
    const mine = await block(tenantA, 'forge@customer.example', 'hard_bounce');
    const response = await call(adminA.token, 'POST', `/email-suppressions/${mine}/lift`, {
      tenantId: tenantB,
      reason: 'complaint',
      liftedBy: adminB.userId,
    });
    expect([204, 422]).toContain(response.status);
    const row = await superuser.query<{
      tenant_id: string;
      reason: string;
      lifted_by: string | null;
    }>(`select tenant_id, reason, lifted_by from email_suppressions where id = $1`, [mine]);
    expect(row.rows[0]).toMatchObject({ tenant_id: tenantA, reason: 'hard_bounce' });
    if (response.status === 204) expect(row.rows[0]!.lifted_by).toBe(adminA.userId);
  });

  it('refuses a malformed id before it reaches the database', async () => {
    expect((await call(adminA.token, 'POST', '/email-suppressions/not-a-uuid/lift')).status).toBe(
      422,
    );
  });

  it('never puts an address in the list’s ids, the audit log or an event', async () => {
    const entries = await harness.fixtures.auditEntries(tenantA, 'email_suppression');
    const events = await harness.fixtures.outboxEventTypes(tenantA);
    const everything = JSON.stringify([entries, events]);
    for (const address of [
      'keep@customer.example',
      'forge@customer.example',
      'shared@customer.example',
    ]) {
      expect(everything).not.toContain(address);
    }
  });
});
