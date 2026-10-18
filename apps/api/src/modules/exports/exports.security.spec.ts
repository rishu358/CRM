import { newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Export endpoints (MVP_SPEC §M8, CLAUDE.md §5.11).
 *
 * "Exports are permission-checked and audited" is two sentences with a lot in
 * them: `export` is its own action, separate from `read`; a request is judged
 * again when the link is issued, not only when it is queued; what was exported
 * is on the audit trail with the filters used; and the file is never served by
 * this process. The file *contents* (escaping, columns, scope) are the worker's
 * and are tested there against real data.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

let tenantA: string;
let tenantB: string;
let roles: ReadonlyMap<string, string>;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
let readOnlyA: { token: string; userId: string };
let adminB: { token: string; userId: string };

const unique = (): string => newId().replaceAll('-', '').slice(-10);

async function userWithRole(tenantId: string, roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Export API A' })).tenantId;
  roles = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Export API B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await userWithRole(tenantA, roles.get('Admin')!);
  repA = await userWithRole(tenantA, roles.get('Sales Rep')!);
  otherRepA = await userWithRole(tenantA, roles.get('Sales Rep')!);
  readOnlyA = await userWithRole(tenantA, roles.get('Read-only')!);
  adminB = await userWithRole(tenantB, rolesB.get('Admin')!);
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

const create = (
  token: string,
  body: Record<string, unknown> = {},
  headers?: Record<string, string>,
) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/exports',
    token,
    headers,
    body: { objectType: 'contact', ...body },
  });

const idOf = (response: { body: Record<string, unknown> }): string =>
  (response.body['data'] as { id: string }).id;

async function jobRow(id: string): Promise<Record<string, unknown>> {
  const row = (await superuser.query('select * from export_jobs where id = $1', [id])).rows[0];
  if (row === undefined) throw new Error(`No job ${id}`);
  return row;
}

/** Leave a job as the worker would, with a file in the store. */
async function complete(id: string, rowCount = 3): Promise<string> {
  const key = (await jobRow(id))['storage_key'] as string;
  harness.storage.put(key, Buffer.from('ID,Last name\r\n1,Sharma\r\n'));
  await superuser.query(
    `update export_jobs set status = 'completed', row_count = $2, size_bytes = 24, finished_at = now() where id = $1`,
    [id, rowCount],
  );
  return key;
}

describe('(d) unauthenticated requests get 401', () => {
  const id = newId();
  const calls = [
    { method: 'POST', url: '/api/v1/exports', body: { objectType: 'contact' } },
    { method: 'GET', url: `/api/v1/exports/${id}` },
    { method: 'POST', url: `/api/v1/exports/${id}/download` },
  ] as const;

  it.each(calls)('$method $url', async (call) => {
    expect((await request(harness, { ...call })).status).toBe(401);
  });
});

describe('`export` is its own action, default deny', () => {
  it('refuses a role that can read but not export', async () => {
    const response = await create(readOnlyA.token);
    expect(response.status).toBe(403);
    expect(response.body['error']).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('accepts a role that can export, and queues the work rather than doing it', async () => {
    const response = await create(repA.token);
    expect(response.status).toBe(202);
    const job = response.body['data'] as { status: string; rowCount: number | null };
    expect(job.status).toBe('queued');
    expect(job.rowCount).toBeNull();

    const events = await superuser.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and event_type = 'export.requested.v1'`,
      [idOf(response)],
    );
    expect(events.rows[0]?.['n']).toBe(1);
  });

  it('is judged per object type', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `contacts-exporter-${unique()}`);
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'export', 'all');
    const user = await userWithRole(tenantA, roleId);
    expect((await create(user.token, { objectType: 'contact' })).status).toBe(202);
    expect((await create(user.token, { objectType: 'deal' })).status).toBe(403);
  });

  it('exports all four objects for a role that may', async () => {
    for (const objectType of ['account', 'contact', 'lead', 'deal']) {
      expect((await create(adminA.token, { objectType })).status, objectType).toBe(202);
    }
  });

  it('refuses an object type it does not know', async () => {
    expect((await create(adminA.token, { objectType: 'invitation' })).status).toBe(422);
    expect((await create(adminA.token, { objectType: 'activities' })).status).toBe(422);
  });
});

describe('the query is the list endpoint’s, validated the same way (CLAUDE.md §5.4, §5.7)', () => {
  it('stores the filter, sort and search that were asked for', async () => {
    const response = await create(adminA.token, {
      filter: ['last_name:starts_with:Sh', 'email:is_not_null:'],
      sort: '-last_name',
      q: 'sharma',
      format: 'xlsx',
    });
    expect(response.status).toBe(202);
    const row = await jobRow(idOf(response));
    expect(row['format']).toBe('xlsx');
    expect(row['query']).toEqual({
      filter: ['last_name:starts_with:Sh', 'email:is_not_null:'],
      sort: '-last_name',
      q: 'sharma',
    });
  });

  it('accepts a single filter string as well as a list', async () => {
    expect((await create(adminA.token, { filter: 'last_name:eq:Sharma' })).status).toBe(202);
  });

  it.each([
    ['an unknown filter field', { filter: ['nope:eq:1'] }],
    ['a malformed filter', { filter: ['no-colons-here'] }],
    ['an unknown sort field', { sort: 'nope' }],
    ['a malformed sort', { sort: 'DROP TABLE contacts' }],
    ['an unknown format', { format: 'pdf' }],
    ['a column list (which columns exist is metadata, not a request)', { fields: 'email' }],
    ['a column list under another name', { columns: ['email'] }],
    ['an ownerId', { ownerId: newId() }],
    ['a tenantId', { tenantId: newId() }],
    ['an oversized search', { q: 'x'.repeat(300) }],
  ])('refuses %s', async (_name, extra) => {
    expect((await create(adminA.token, extra)).status).toBe(422);
  });

  it('refuses to filter or sort by a field the caller cannot read, exactly as for a field that does not exist', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `blind-${unique()}`);
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'export', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    const blind = await userWithRole(tenantA, roleId);

    const attempts = [
      create(blind.token, { filter: ['phone:starts_with:+91'] }),
      create(blind.token, { sort: 'phone' }),
      create(blind.token, { filter: ['no_such_field:starts_with:+91'] }),
      create(blind.token, { sort: 'no_such_field' }),
    ];
    const [filterHidden, sortHidden, filterMissing, sortMissing] = await Promise.all(attempts);
    for (const response of [filterHidden!, sortHidden!, filterMissing!, sortMissing!]) {
      expect(response.status).toBe(422);
    }
    const detail = (r: { body: Record<string, unknown> }) =>
      JSON.stringify((r.body['error'] as { details: unknown[] }).details).replace(
        /phone|no_such_field/g,
        '<field>',
      );
    expect(detail(filterHidden!)).toBe(detail(filterMissing!));
    expect(detail(sortHidden!)).toBe(detail(sortMissing!));
  });

  it('accepts a custom field, the moment it exists', async () => {
    const key = `tier_${unique()}`;
    expect((await create(adminA.token, { filter: [`${key}:eq:gold`] })).status).toBe(422);
    await superuser.query(
      `insert into field_definitions (id, tenant_id, object_type, key, label, type, position, is_system, is_active)
       values ($1, $2, 'contact', $3, 'Tier', 'text', 900, false, true)`,
      [newId(), tenantA, key],
    );
    expect((await create(adminA.token, { filter: [`${key}:eq:gold`], sort: key })).status).toBe(
      202,
    );
  });
});

describe('audit (CLAUDE.md §5.10, §5.11)', () => {
  it('records the request with what was asked for, against the person who asked', async () => {
    const response = await create(adminA.token, { filter: ['last_name:eq:Sharma'], format: 'csv' });
    const entries = await superuser.query(
      `select action, object_type, actor_id, changes from audit_logs
       where tenant_id = $1 and record_id = $2`,
      [tenantA, idOf(response)],
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]).toMatchObject({
      action: 'export',
      object_type: 'contact',
      actor_id: adminA.userId,
    });
    expect(entries.rows[0]?.['changes']).toMatchObject({
      format: { new: 'csv' },
      filter: { new: ['last_name:eq:Sharma'] },
    });
  });

  it('records each link that is issued, with the row count that was available', async () => {
    const response = await create(adminA.token);
    await complete(idOf(response), 7);
    await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });

    const entries = await superuser.query(
      `select changes from audit_logs where tenant_id = $1 and record_id = $2 and action = 'export' order by occurred_at`,
      [tenantA, idOf(response)],
    );
    // One for the request, one per link: three moments the data could leave.
    expect(entries.rows).toHaveLength(3);
    expect(entries.rows[1]?.['changes']).toMatchObject({
      download: { new: 'link issued' },
      rowCount: { new: 7 },
    });
  });
});

describe('download: a short-lived presigned URL, never the file', () => {
  it('is a 409 until the export is complete, or if it failed', async () => {
    const response = await create(adminA.token);
    const early = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    expect(early.status).toBe(409);

    await superuser.query(
      `update export_jobs set status = 'failed', failure_reason = 'x' where id = $1`,
      [idOf(response)],
    );
    const failed = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    expect(failed.status).toBe(409);
  });

  it('returns only a URL and an expiry, signed for minutes, for the generated file', async () => {
    const response = await create(adminA.token, { format: 'csv' });
    const key = await complete(idOf(response));
    const reads = harness.storage.reads;

    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    expect(link.status).toBe(200);
    const data = link.body['data'] as { url: string; expiresAt: string };
    expect(Object.keys(data).sort()).toEqual(['expiresAt', 'url']);
    expect(new Date(data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1000 + 5_000,
    );

    const signed = harness.storage.issuedDownloadRequests.at(-1)!;
    expect(signed).toMatchObject({ key, expiresInSeconds: 300, contentType: 'text/csv' });
    // The browser saves it; it is never rendered.
    expect(signed.fileName).toMatch(/^contacts-[0-9a-f]{8}\.csv$/);
    expect(harness.storage.reads).toBe(reads);
    expect(Buffer.from(harness.storage.simulateDownload(data.url)).toString()).toContain('Sharma');
  });

  it('serves an xlsx with the spreadsheet type', async () => {
    const response = await create(adminA.token, { format: 'xlsx' });
    await complete(idOf(response));
    await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    expect(harness.storage.issuedDownloadRequests.at(-1)).toMatchObject({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(harness.storage.issuedDownloadRequests.at(-1)!.fileName).toMatch(/\.xlsx$/);
  });

  it('the link stops working after it expires', async () => {
    const response = await create(adminA.token);
    await complete(idOf(response));
    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    const url = (link.body['data'] as { url: string }).url;
    const real = harness.storage.now;
    try {
      harness.storage.now = () => new Date(Date.now() + 6 * 60 * 1000);
      expect(() => harness.storage.simulateDownload(url)).toThrow(/expired/);
    } finally {
      harness.storage.now = real;
    }
  });

  it('refuses once the export itself has expired, even though the file is still there', async () => {
    const response = await create(adminA.token);
    await complete(idOf(response));
    await superuser.query(
      `update export_jobs set expires_at = now() - interval '1 minute' where id = $1`,
      [idOf(response)],
    );
    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: adminA.token,
    });
    expect(link.status).toBe(404);
  });

  it('re-checks permission when the link is issued: revoking export after the run stops the download', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `revocable-${unique()}`);
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'export', 'all');
    const user = await userWithRole(tenantA, roleId);

    const response = await create(user.token);
    await complete(idOf(response));
    await superuser.query(
      `delete from role_permissions where tenant_id = $1 and role_id = $2 and action = 'export'`,
      [tenantA, roleId],
    );

    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/exports/${idOf(response)}/download`,
      token: user.token,
    });
    expect(link.status).toBe(403);
    const status = await request(harness, {
      method: 'GET',
      url: `/api/v1/exports/${idOf(response)}`,
      token: user.token,
    });
    expect(status.status).toBe(403);
  });
});

describe('idempotency (CLAUDE.md §6)', () => {
  it('a repeated Idempotency-Key returns the export it already made, not a second one', async () => {
    const key = `exp-${unique()}`;
    const first = await create(adminA.token, {}, { 'Idempotency-Key': key });
    const second = await create(adminA.token, {}, { 'Idempotency-Key': key });
    expect(first.status).toBe(202);
    expect(idOf(second)).toBe(idOf(first));
    const rows = await superuser.query(
      'select count(*)::int as n from export_jobs where idempotency_key = $1',
      [key],
    );
    expect(rows.rows[0]?.['n']).toBe(1);
    const audit = await superuser.query(
      `select count(*)::int as n from audit_logs where record_id = $1 and action = 'export'`,
      [idOf(first)],
    );
    expect(audit.rows[0]?.['n']).toBe(1);
  });
});

describe('(a) tenant isolation and (b) a job is private to whoever asked', () => {
  it('another tenant gets 404 for status and download', async () => {
    const response = await create(adminA.token);
    await complete(idOf(response));
    for (const call of [
      { method: 'GET', url: `/api/v1/exports/${idOf(response)}` },
      { method: 'POST', url: `/api/v1/exports/${idOf(response)}/download` },
    ] as const) {
      const other = await request(harness, { ...call, token: adminB.token });
      expect(other.status, call.url).toBe(404);
    }
  });

  it('another user in the same tenant, even an Admin, gets 404', async () => {
    const response = await create(repA.token);
    await complete(idOf(response));
    for (const user of [otherRepA, adminA]) {
      expect(
        (
          await request(harness, {
            method: 'GET',
            url: `/api/v1/exports/${idOf(response)}`,
            token: user.token,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(harness, {
            method: 'POST',
            url: `/api/v1/exports/${idOf(response)}/download`,
            token: user.token,
          })
        ).status,
      ).toBe(404);
    }
  });

  it('a made-up id is the same 404 as someone else’s', async () => {
    const mine = await create(repA.token);
    const theirs = await request(harness, {
      method: 'GET',
      url: `/api/v1/exports/${idOf(mine)}`,
      token: otherRepA.token,
    });
    const missing = await request(harness, {
      method: 'GET',
      url: `/api/v1/exports/${newId()}`,
      token: otherRepA.token,
    });
    expect(theirs.body['error']).toEqual({
      ...(missing.body['error'] as object),
      requestId: (theirs.body['error'] as { requestId: string }).requestId,
    });
  });
});
