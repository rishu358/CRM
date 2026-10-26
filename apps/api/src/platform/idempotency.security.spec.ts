import { newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';

/**
 * `Idempotency-Key` on every route that creates a record (CLAUDE.md §6, pilot finding F6).
 *
 * Before this, only imports, exports, data-rights requests and bulk actions honoured it: `POST /accounts`
 * twice with the same key made two accounts, so a flaky connection that retried a save created
 * duplicates. One mechanism now answers for all of them, and these are its rules, asserted on each route:
 *
 *   - the same key with the same request returns the first answer and creates nothing more;
 *   - the same key for a different request is refused (409), never answered with the wrong record;
 *   - two requests racing on one key create one record;
 *   - a key is one person's own, in one workspace: another person, or another workspace, using the same
 *     text gets an independent record and never sees the first one's answer;
 *   - a request that fails stores nothing, so the retry can succeed;
 *   - without a key nothing changes.
 *
 * Plus the four mandatory suites for the shared table (CLAUDE.md §10): unauthenticated 401, tenant
 * isolation, own-person scope, and that no hidden field leaks through a replay.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;
let tenantA: string;
let tenantB: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let adminB: { token: string; userId: string };

async function user(tenantId: string, roleId: string) {
  const created = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: created.userId, token: await harness.signIn(created.userId, tenantId) };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Idempotency A' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Idempotency B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await user(tenantA, rolesA.get('Admin')!);
  repA = await user(tenantA, rolesA.get('Sales Rep')!);
  adminB = await user(tenantB, rolesB.get('Admin')!);
}, 240_000);

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

const key = (): string => `k-${newId()}`;

/** One create route: where it is, what to send, and where the record lands. */
interface CreateRoute {
  readonly name: string;
  readonly url: string;
  readonly table: string;
  readonly column: string;
  readonly body: (marker: string) => Record<string, unknown>;
  /** The created record's id in a response. */
  readonly idOf: (body: Record<string, unknown>) => string;
}

const dataId = (body: Record<string, unknown>): string => (body['data'] as { id: string }).id;

const ROUTES: readonly CreateRoute[] = [
  {
    name: 'accounts',
    url: '/api/v1/accounts',
    table: 'accounts',
    column: 'name',
    body: (marker) => ({ name: marker }),
    idOf: dataId,
  },
  {
    name: 'contacts',
    url: '/api/v1/contacts',
    table: 'contacts',
    column: 'last_name',
    body: (marker) => ({ lastName: marker }),
    idOf: dataId,
  },
  {
    name: 'leads',
    url: '/api/v1/leads',
    table: 'leads',
    column: 'last_name',
    body: (marker) => ({ lastName: marker }),
    idOf: dataId,
  },
  {
    name: 'deals',
    url: '/api/v1/deals',
    table: 'deals',
    column: 'name',
    body: (marker) => ({ name: marker }),
    idOf: dataId,
  },
  {
    name: 'activities',
    url: '/api/v1/activities',
    table: 'activities',
    column: 'subject',
    body: (marker) => ({ type: 'note', subject: marker }),
    idOf: dataId,
  },
];

async function countRows(route: CreateRoute, marker: string, tenantId = tenantA): Promise<number> {
  const result = await superuser.query(
    `select count(*)::int as n from ${route.table} where tenant_id = $1 and ${route.column} = $2`,
    [tenantId, marker],
  );
  return (result.rows[0] as { n: number }).n;
}

const post = (
  route: CreateRoute,
  token: string | undefined,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) =>
  request(harness, {
    method: 'POST',
    url: route.url,
    token,
    body,
    ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
  });

describe.each(ROUTES)('POST $url', (route) => {
  it('answers a retry with the first answer and creates nothing more', async () => {
    const marker = `Once ${newId()}`;
    const k = key();
    const first = await post(route, adminA.token, route.body(marker), k);
    expect(first.status).toBe(201);
    expect(await countRows(route, marker)).toBe(1);

    const retry = await post(route, adminA.token, route.body(marker), k);
    expect(retry.status).toBe(201);
    expect(route.idOf(retry.body)).toBe(route.idOf(first.body));
    expect(retry.body['data']).toEqual(first.body['data']);
    expect(await countRows(route, marker)).toBe(1);
  });

  it('writes the audit entry and the created event once, not once per retry', async () => {
    const marker = `Audit ${newId()}`;
    const k = key();
    await post(route, adminA.token, route.body(marker), k);
    await post(route, adminA.token, route.body(marker), k);
    await post(route, adminA.token, route.body(marker), k);

    const audits = await superuser.query(
      `select count(*)::int as n from audit_logs
        where tenant_id = $1 and action = 'create'
          and record_id in (select id from ${route.table} where tenant_id = $1 and ${route.column} = $2)`,
      [tenantA, marker],
    );
    expect((audits.rows[0] as { n: number }).n).toBe(1);
    const created = await superuser.query(
      `select count(*)::int as n from outbox_events
        where tenant_id = $1 and event_type like '%.created.v1'
          and record_id in (select id from ${route.table} where tenant_id = $1 and ${route.column} = $2)`,
      [tenantA, marker],
    );
    expect((created.rows[0] as { n: number }).n).toBe(1);
  });

  it('refuses the same key for a different request, and creates nothing', async () => {
    const k = key();
    const markerA = `Mine ${newId()}`;
    const markerB = `Other ${newId()}`;
    expect((await post(route, adminA.token, route.body(markerA), k)).status).toBe(201);

    const different = await post(route, adminA.token, route.body(markerB), k);
    expect(different.status).toBe(409);
    expect(await countRows(route, markerB)).toBe(0);
    expect(await countRows(route, markerA)).toBe(1);
  });

  it('creates one record when several identical requests race on one key', async () => {
    const marker = `Race ${newId()}`;
    const k = key();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => post(route, adminA.token, route.body(marker), k)),
    );
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(answers.map((answer) => route.idOf(answer.body))).size).toBe(1);
    expect(await countRows(route, marker)).toBe(1);
  });

  it('is one person’s own key: another person using the same text creates their own record', async () => {
    const marker = `Shared ${newId()}`;
    const k = key();
    const mine = await post(route, adminA.token, route.body(marker), k);
    const theirs = await post(route, repA.token, route.body(marker), k);
    // The rep may not be allowed to create this kind of record at all; if so the refusal must be a
    // refusal, never the admin's stored answer.
    if (theirs.status === 201) {
      expect(route.idOf(theirs.body)).not.toBe(route.idOf(mine.body));
      expect(await countRows(route, marker)).toBe(2);
    } else {
      expect([403, 409, 422]).toContain(theirs.status);
      expect(JSON.stringify(theirs.body)).not.toContain(route.idOf(mine.body));
    }
  });

  it('is one workspace’s own key: the same text in another workspace is independent', async () => {
    const marker = `Cross ${newId()}`;
    const k = key();
    const inA = await post(route, adminA.token, route.body(marker), k);
    expect(inA.status).toBe(201);
    const inB = await post(route, adminB.token, route.body(marker), k);
    expect(inB.status).toBe(201);
    expect(route.idOf(inB.body)).not.toBe(route.idOf(inA.body));
    expect(JSON.stringify(inB.body)).not.toContain(route.idOf(inA.body));
    expect(await countRows(route, marker, tenantA)).toBe(1);
    expect(await countRows(route, marker, tenantB)).toBe(1);
  });

  it('stores nothing when the request fails, so a corrected retry with the same key succeeds', async () => {
    const k = key();
    // 422: an unknown key in the body is refused before anything is written.
    const bad = await post(route, adminA.token, { ...route.body('Bad'), notAField: 1 }, k);
    expect(bad.status).toBe(422);
    const marker = `Fixed ${newId()}`;
    const fixed = await post(route, adminA.token, route.body(marker), k);
    expect(fixed.status).toBe(201);
    expect(await countRows(route, marker)).toBe(1);
  });

  it('without a key, two identical requests make two records, as before', async () => {
    const marker = `Plain ${newId()}`;
    await post(route, adminA.token, route.body(marker));
    await post(route, adminA.token, route.body(marker));
    expect(await countRows(route, marker)).toBe(2);
  });

  it('refuses a malformed key with 422 and creates nothing', async () => {
    const marker = `BadKey ${newId()}`;
    const response = await post(route, adminA.token, route.body(marker), 'not a valid key!');
    expect(response.status).toBe(422);
    expect(await countRows(route, marker)).toBe(0);
  });

  it('refuses without credentials (401) even when a key is sent', async () => {
    const response = await post(route, undefined, route.body(`Anon ${newId()}`), key());
    expect(response.status).toBe(401);
  });
});

describe('a key is not a way to read somebody else’s answer', () => {
  it('never returns another person’s stored response, whatever the key and body', async () => {
    const route = ROUTES[1]!; // contacts
    const marker = `Secret ${newId()}`;
    const k = key();
    const original = await post(
      route,
      adminA.token,
      { lastName: marker, email: `secret-${newId().slice(-8)}@private.example` },
      k,
    );
    expect(original.status).toBe(201);

    // The rep sends the very same key and body: this is a new request from a different person.
    const probe = await post(
      route,
      repA.token,
      { lastName: marker, email: (original.body['data'] as { email: string }).email },
      k,
    );
    expect(probe.status).toBe(201);
    expect(dataId(probe.body)).not.toBe(dataId(original.body));

    // And the stored copy itself is invisible to the application role of another person: the
    // restrictive policy limits a person to their own rows.
    const rows = await superuser.query(
      `select created_by from bulk_operations where tenant_id = $1 and idempotency_key = $2`,
      [tenantA, k],
    );
    expect(rows.rows.map((row) => (row as { created_by: string }).created_by).sort()).toEqual(
      [adminA.userId, repA.userId].sort(),
    );
  });

  it('keeps a hidden field out of a replay as it was out of the first answer', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `No phone ${newId()}`);
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'own');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    const blind = await user(tenantA, roleId);
    const k = key();
    const marker = `Blind ${newId()}`;
    const first = await post(ROUTES[1]!, blind.token, { lastName: marker }, k);
    expect(first.status).toBe(201);
    const replay = await post(ROUTES[1]!, blind.token, { lastName: marker }, k);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(JSON.stringify(replay.body)).not.toContain('phone');
  });
});

describe('converting a lead', () => {
  it('answers a retry with the first conversion instead of "already converted"', async () => {
    const email = `convert-${newId().slice(-8)}@convert.example`;
    const leadId = await harness.fixtures.createLead(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Convertible',
      email,
    });
    const k = key();
    const body = {
      version: 1,
      contact: { mode: 'create' },
      account: { mode: 'none' },
      acknowledgeDuplicates: true,
    };
    const send = (idempotencyKey?: string) =>
      request(harness, {
        method: 'POST',
        url: `/api/v1/leads/${leadId}/convert`,
        token: adminA.token,
        body,
        ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
      });

    const first = await send(k);
    expect(first.status).toBe(200);
    const retry = await send(k);
    expect(retry.status).toBe(200);
    expect((retry.body['data'] as { contact: { id: string } }).contact.id).toBe(
      (first.body['data'] as { contact: { id: string } }).contact.id,
    );

    const contacts = await superuser.query(
      `select count(*)::int as n from contacts where tenant_id = $1 and email = $2`,
      [tenantA, email],
    );
    expect((contacts.rows[0] as { n: number }).n).toBe(1);

    // Without the key, the second attempt is still the honest conflict it always was.
    expect((await send()).status).toBe(409);
  });
});

describe('what is kept', () => {
  it('forgets a person’s old answers when they next use a key, and not their recent ones', async () => {
    const route = ROUTES[0]!;
    const oldKey = key();
    await post(route, adminA.token, route.body(`Old ${newId()}`), oldKey);
    await superuser.query(
      `update bulk_operations set created_at = now() - interval '25 hours'
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantA, oldKey],
    );
    const recentKey = key();
    await post(route, adminA.token, route.body(`Recent ${newId()}`), recentKey);
    await post(route, adminA.token, route.body(`Trigger ${newId()}`), key());

    const left = await superuser.query(
      `select idempotency_key from bulk_operations where tenant_id = $1 and idempotency_key = any($2)`,
      [tenantA, [oldKey, recentKey]],
    );
    expect(left.rows.map((row) => (row as { idempotency_key: string }).idempotency_key)).toEqual([
      recentKey,
    ]);
  });
});
