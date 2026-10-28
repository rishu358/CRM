import { IMPORT_LIMITS, newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Import endpoints (MVP_SPEC §M8, CLAUDE.md §5.12, ADR-0029).
 *
 * The four mandatory suites (§10) plus the file-handling rules. What these tests
 * establish about the *API* is mostly about what it refuses and what it never
 * does: it never receives a file, never reads one, hands out only short-lived
 * presigned URLs for random keys, and lets a user see only their own jobs.
 * Parsing, type detection by magic bytes and the size/row/column/decompression
 * limits are the worker's, and are tested there with real files.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

let tenantA: string;
let tenantB: string;
let roles: ReadonlyMap<string, string>;

let adminA: { token: string; userId: string };
let managerA: { token: string; userId: string };
let otherManagerA: { token: string; userId: string };
let repA: { token: string; userId: string };
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

  tenantA = (await harness.fixtures.createTenant({ name: 'Import API A' })).tenantId;
  roles = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Import API B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await userWithRole(tenantA, roles.get('Admin')!);
  managerA = await userWithRole(tenantA, roles.get('Manager')!);
  otherManagerA = await userWithRole(tenantA, roles.get('Manager')!);
  repA = await userWithRole(tenantA, roles.get('Sales Rep')!);
  readOnlyA = await userWithRole(tenantA, roles.get('Read-only')!);
  adminB = await userWithRole(tenantB, rolesB.get('Admin')!);
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

interface Created {
  id: string;
  upload: { url: string; method: string; headers: Record<string, string>; expiresAt: string };
}

async function createImport(
  token: string,
  overrides: Record<string, unknown> = {},
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; created?: Created }> {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/imports',
    token,
    headers,
    body: { objectType: 'contact', fileName: 'people.csv', sizeBytes: 100, ...overrides },
  });
  // Tolerant on purpose: this helper also serves tests of refusals, where there
  // is no data envelope to read and the caller asserts on `status` instead.
  const data = response.body['data'] as
    { job: { id: string }; upload: Created['upload'] } | undefined;
  return {
    ...response,
    ...(data === undefined || data.upload === null
      ? {}
      : { created: { id: data.job.id, upload: data.upload } }),
  };
}

/** Play the browser: PUT bytes to the presigned URL, then say so. */
async function uploadFile(token: string, bytes: Buffer, fileName = 'people.csv') {
  const { created } = await createImport(token, { fileName, sizeBytes: bytes.length });
  expect(created).toBeDefined();
  harness.storage.simulateUpload(
    created!.upload.url,
    bytes,
    created!.upload.headers['Content-Type'] as string,
  );
  return created!.id;
}

async function jobRow(id: string): Promise<Record<string, unknown>> {
  const row = (await superuser.query('select * from import_jobs where id = $1', [id])).rows[0];
  if (row === undefined) throw new Error(`No job ${id}`);
  return row;
}

async function setJob(id: string, set: string, values: unknown[] = []): Promise<void> {
  await superuser.query(`update import_jobs set ${set} where id = $${values.length + 1}`, [
    ...values,
    id,
  ]);
}

/** Put a job where the worker would leave it after analysis. */
async function awaitMapping(id: string): Promise<void> {
  await setJob(id, `status = 'analyzing'`);
  await setJob(
    id,
    `status = 'awaiting_mapping', detected_format = 'csv', columns = $1::jsonb,
     preview = $2::jsonb, total_rows = 2`,
    [JSON.stringify(['First', 'Last', 'Email']), JSON.stringify([['a', 'b', 'c']])],
  );
}

describe('(d) unauthenticated requests get 401', () => {
  const id = newId();
  const calls = [
    { method: 'POST', url: '/api/v1/imports', body: { objectType: 'contact' } },
    { method: 'GET', url: '/api/v1/imports' },
    { method: 'GET', url: `/api/v1/imports/${id}` },
    { method: 'POST', url: `/api/v1/imports/${id}/uploaded` },
    { method: 'POST', url: `/api/v1/imports/${id}/start`, body: {} },
    { method: 'POST', url: `/api/v1/imports/${id}/check`, body: {} },
    { method: 'POST', url: `/api/v1/imports/${id}/error-file` },
  ] as const;

  it.each(calls)('$method $url', async (call) => {
    const response = await request(harness, { ...call });
    expect(response.status).toBe(401);
  });
});

describe('authorization: `import` is its own action, default deny', () => {
  it('lets a role that holds import create one', async () => {
    expect((await createImport(managerA.token)).status).toBe(201);
    expect((await createImport(adminA.token)).status).toBe(201);
  });

  it('refuses a Sales Rep (who may export but not import) and a Read-only role', async () => {
    for (const user of [repA, readOnlyA]) {
      const response = await createImport(user.token);
      expect(response.status).toBe(403);
    }
  });

  it('refuses listing and reading for a role with no import grant', async () => {
    expect(
      (await request(harness, { method: 'GET', url: '/api/v1/imports', token: repA.token })).status,
    ).toBe(403);
    expect(
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/imports/${newId()}`,
          token: repA.token,
        })
      ).status,
    ).toBe(403);
  });

  it('is judged per object type: import on contacts is not import on accounts', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `contacts-only-${unique()}`);
    for (const action of ['read', 'create', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'all');
    }
    const user = await userWithRole(tenantA, roleId);
    expect((await createImport(user.token, { objectType: 'contact' })).status).toBe(201);
    expect((await createImport(user.token, { objectType: 'account' })).status).toBe(403);
  });

  it('does not import deals: that is a business rule the spec does not give', async () => {
    const response = await createImport(adminA.token, { objectType: 'deal' });
    expect(response.status).toBe(422);
  });
});

describe('§5.12: the API never receives, reads or stores a file', () => {
  it('answers create with a presigned URL bound to the declared size and a server-chosen type', async () => {
    const before = { reads: harness.storage.reads, writes: harness.storage.writes };
    const { created, status } = await createImport(managerA.token, {
      fileName: 'customers.csv',
      sizeBytes: 4321,
    });
    expect(status).toBe(201);

    const signed = harness.storage.issuedUploadRequests.at(-1)!;
    expect(signed.sizeBytes).toBe(4321);
    // The type comes from the claimed format, never from the request.
    expect(signed.contentType).toBe('text/csv');
    expect(created!.upload.method).toBe('PUT');
    // The type is for the client to send; the length is signed but implied by the body.
    expect(created!.upload.headers).toEqual({ 'Content-Type': 'text/csv' });

    // Short-lived: minutes, not hours.
    const ttlMs = new Date(created!.upload.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);

    expect(harness.storage.reads).toBe(before.reads);
    expect(harness.storage.writes).toBe(before.writes);
  });

  it('binds an .xlsx upload to the spreadsheet type, whatever the client says', async () => {
    await createImport(managerA.token, { fileName: 'book.xlsx', sizeBytes: 10 });
    expect(harness.storage.issuedUploadRequests.at(-1)!.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('has no endpoint that accepts a file, and ignores a contentType in the body by rejecting it', async () => {
    const response = await createImport(managerA.token, {
      contentType: 'application/x-msdownload',
    });
    expect(response.status).toBe(422);
  });

  it('generates a random storage key that does not contain the filename', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const { created } = await createImport(managerA.token, { fileName: 'secret-customers.csv' });
      const key = (await jobRow(created!.id))['storage_key'] as string;
      expect(key).not.toContain('secret');
      expect(key).not.toContain('customers');
      expect(key).toMatch(new RegExp(`^tenants/${tenantA}/imports/[A-Za-z0-9_-]{40,}$`));
      keys.add(key);
    }
    expect(keys.size).toBe(5);
  });

  it('never returns the storage key or the error-file key', async () => {
    const { created } = await createImport(managerA.token);
    const key = (await jobRow(created!.id))['storage_key'] as string;
    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/imports/${created!.id}`,
      token: managerA.token,
    });
    const body = JSON.stringify(read.body);
    expect(body).not.toContain(key);
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('errorFileKey');
  });

  it.each([
    ['a path in the filename', 'a/b.csv'],
    ['a traversal', '..\\..\\evil.csv'],
    ['a control character', 'bad\u0000.csv'],
    ['an executable extension', 'payload.exe'],
    ['a double extension', 'payload.csv.exe'],
    ['a legacy .xls', 'old.xls'],
    ['no extension', 'customers'],
  ])('refuses %s', async (_name, fileName) => {
    expect((await createImport(managerA.token, { fileName })).status).toBe(422);
  });

  it('refuses a size over the limit, an empty file, and a non-integer', async () => {
    for (const sizeBytes of [IMPORT_LIMITS.maxUploadBytes + 1, 0, -5, 12.5, '100']) {
      expect((await createImport(managerA.token, { sizeBytes })).status, String(sizeBytes)).toBe(
        422,
      );
    }
    expect(
      (await createImport(managerA.token, { sizeBytes: IMPORT_LIMITS.maxUploadBytes })).status,
    ).toBe(201);
  });

  it('refuses unknown keys, which is how an ownerId, tenantId or version would arrive', async () => {
    for (const extra of [
      { ownerId: newId() },
      { tenantId: tenantB },
      { version: 9 },
      { createdBy: newId() },
    ]) {
      expect((await createImport(managerA.token, extra)).status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('confirm: a missing upload is a 409, a wrong-sized one is refused and deleted', async () => {
    const { created } = await createImport(managerA.token, { sizeBytes: 50 });
    const missing = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/uploaded`,
      token: managerA.token,
    });
    expect(missing.status).toBe(409);

    const key = (await jobRow(created!.id))['storage_key'] as string;
    harness.storage.put(key, Buffer.alloc(51)); // not the declared size
    const wrong = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/uploaded`,
      token: managerA.token,
    });
    expect(wrong.status).toBe(202);
    expect(dataOf<{ status: string; failureReason: string }>(wrong).status).toBe('rejected');
    expect(dataOf<{ failureReason: string }>(wrong).failureReason).toMatch(/not the size/);
    expect(harness.storage.has(key)).toBe(false);
  });

  it('confirm: queues analysis in the same transaction as the status change, and is idempotent', async () => {
    const id = await uploadFile(managerA.token, Buffer.from('a,b\n1,2\n'));
    const first = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${id}/uploaded`,
      token: managerA.token,
    });
    expect(first.status).toBe(202);
    expect(dataOf<{ status: string }>(first).status).toBe('analyzing');

    const second = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${id}/uploaded`,
      token: managerA.token,
    });
    expect(second.status).toBe(202);
    expect(dataOf<{ status: string }>(second).status).toBe('analyzing');

    // One event, not two.
    const events = await superuser.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and event_type = 'import.uploaded.v1'`,
      [id],
    );
    expect(events.rows[0]?.['n']).toBe(1);
  });

  it('confirm: after all of that, the API still has not read or written a byte', async () => {
    const reads = harness.storage.reads;
    const writes = harness.storage.writes;
    const id = await uploadFile(managerA.token, Buffer.from('a\n1\n'));
    await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${id}/uploaded`,
      token: managerA.token,
    });
    expect(harness.storage.reads).toBe(reads);
    expect(harness.storage.writes).toBe(writes);
  });
});

describe('idempotency (CLAUDE.md §6)', () => {
  it('returns the job it already made for a repeated Idempotency-Key', async () => {
    const key = `key-${unique()}`;
    const first = await createImport(managerA.token, {}, { 'Idempotency-Key': key });
    const second = await createImport(managerA.token, {}, { 'Idempotency-Key': key });
    const idOf = (r: { status: number; body: Record<string, unknown> }) =>
      dataOf<{ job: { id: string } }>(r).job.id;
    expect(first.status).toBe(201);
    expect(idOf(second)).toBe(idOf(first));

    const rows = await superuser.query(
      'select count(*)::int as n from import_jobs where idempotency_key = $1',
      [key],
    );
    expect(rows.rows[0]?.['n']).toBe(1);
  });

  it('scopes a key to the person who sent it', async () => {
    const key = `shared-${unique()}`;
    const a = await createImport(managerA.token, {}, { 'Idempotency-Key': key });
    const b = await createImport(otherManagerA.token, {}, { 'Idempotency-Key': key });
    const idOf = (r: { status: number; body: Record<string, unknown> }) =>
      dataOf<{ job: { id: string } }>(r).job.id;
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it('rejects a malformed key', async () => {
    const response = await createImport(
      managerA.token,
      {},
      { 'Idempotency-Key': 'has spaces and <tags>' },
    );
    expect(response.status).toBe(422);
  });
});

describe('(a) tenant isolation', () => {
  it('another tenant cannot read, confirm, start or fetch the error file of a job', async () => {
    const { created } = await createImport(managerA.token);
    const id = created!.id;
    await awaitMapping(id);

    const attempts = [
      { method: 'GET', url: `/api/v1/imports/${id}` },
      { method: 'POST', url: `/api/v1/imports/${id}/uploaded` },
      {
        method: 'POST',
        url: `/api/v1/imports/${id}/start`,
        body: { mapping: [{ column: 0, field: 'last_name' }], duplicateMode: 'create' },
      },
      { method: 'POST', url: `/api/v1/imports/${id}/error-file` },
    ] as const;
    for (const attempt of attempts) {
      const response = await request(harness, { ...attempt, token: adminB.token });
      expect(response.status, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    // Untouched.
    expect((await jobRow(id))['status']).toBe('awaiting_mapping');
  });

  it('does not list another tenant’s jobs', async () => {
    await createImport(managerA.token);
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/imports',
      token: adminB.token,
    });
    expect(response.status).toBe(200);
    expect(dataOf(response)).toEqual([]);
  });

  it('answers 404, not 403, so the id is not confirmed to exist', async () => {
    const { created } = await createImport(managerA.token);
    const other = await request(harness, {
      method: 'GET',
      url: `/api/v1/imports/${created!.id}`,
      token: adminB.token,
    });
    const missing = await request(harness, {
      method: 'GET',
      url: `/api/v1/imports/${newId()}`,
      token: adminB.token,
    });
    expect(other.status).toBe(404);
    expect(other.body['error']).toMatchObject({ code: 'NOT_FOUND' });
    expect((other.body['error'] as { message: string }).message).toBe(
      (missing.body['error'] as { message: string }).message,
    );
  });
});

describe('(b) scope: a job is private to the person who started it', () => {
  it('another user in the same tenant, even an Admin, gets 404', async () => {
    const { created } = await createImport(managerA.token);
    for (const other of [otherManagerA, adminA]) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/imports/${created!.id}`,
        token: other.token,
      });
      expect(response.status).toBe(404);
    }
  });

  it('lists only the caller’s own jobs', async () => {
    const mine = await createImport(otherManagerA.token);
    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/imports?limit=100',
      token: otherManagerA.token,
    });
    const ids = dataOf<{ id: string }[]>(list).map((job) => job.id);
    expect(ids).toContain(mine.created!.id);

    const managersJobs = dataOf<{ id: string }[]>(
      await request(harness, {
        method: 'GET',
        url: '/api/v1/imports?limit=100',
        token: managerA.token,
      }),
    );
    for (const job of managersJobs) expect(ids).not.toContain(job.id);
  });

  it('pages by keyset, newest first, with no duplicates', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `pager-${unique()}`);
    for (const action of ['read', 'create', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'all');
    }
    const pager = await userWithRole(tenantA, roleId);
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await createImport(pager.token)).created!.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string = `/api/v1/imports?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await request(harness, { method: 'GET', url, token: pager.token });
      seen.push(...dataOf<{ id: string }[]>(response).map((job) => job.id));
      const meta = response.body['meta'] as { nextCursor: string | null; hasMore: boolean };
      if (!meta.hasMore) break;
      cursor = meta.nextCursor;
    }
    expect(seen).toEqual([...made].reverse());
  });
});

describe('(c) field-level permissions and what a column may be mapped to', () => {
  async function jobForMapping(token: string, objectType = 'contact'): Promise<string> {
    const { created } = await createImport(token, { objectType });
    await awaitMapping(created!.id);
    return created!.id;
  }

  const start = (token: string, id: string, body: Record<string, unknown>) =>
    request(harness, { method: 'POST', url: `/api/v1/imports/${id}/start`, token, body });

  it('offers targets from live metadata: system allowlist, custom fields, and the owner to a manager who may reassign', async () => {
    await superuser.query(
      `insert into field_definitions (id, tenant_id, object_type, key, label, type, position, is_system, is_active)
       values ($1, $2, 'contact', 'region_${tenantA.slice(-4)}', 'Region', 'text', 900, false, true)`,
      [newId(), tenantA],
    );
    const id = await jobForMapping(managerA.token);
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/imports/${id}`,
      token: managerA.token,
    });
    const data = dataOf<{ targets: { key: string }[]; matchFields: string[] }>(response);
    const keys = data.targets.map((target) => target.key);

    expect(keys).toEqual(
      expect.arrayContaining(['last_name', 'email', `region_${tenantA.slice(-4)}`]),
    );
    // A manager reassigns inside their team (ADR-0058), so the file may name an owner (ADR-0067).
    expect(keys).toContain('owner_id');
    expect(data.matchFields).toEqual(['email', 'phone']);
  });

  it('does not offer a field the caller may read but not write, nor a hidden one', async () => {
    // `update` is what gives a role write access to fields at all (field access
    // derives from the object grant; a field row can only narrow it).
    const roleId = await harness.fixtures.createRole(tenantA, `limited-${unique()}`);
    for (const action of ['read', 'create', 'update', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'all');
    }
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'title', 'read');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    const limited = await userWithRole(tenantA, roleId);

    const id = await jobForMapping(limited.token);
    const data = dataOf<{ targets: { key: string }[] }>(
      await request(harness, { method: 'GET', url: `/api/v1/imports/${id}`, token: limited.token }),
    );
    const keys = data.targets.map((target) => target.key);
    expect(keys).toContain('email');
    expect(keys).not.toContain('title');
    expect(keys).not.toContain('phone');
  });

  it('refuses to start with a column mapped to a field the caller cannot write', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `limited2-${unique()}`);
    for (const action of ['read', 'create', 'update', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'all');
    }
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'title', 'read');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'phone', 'hidden');
    const limited = await userWithRole(tenantA, roleId);

    const body = (field: string) => ({
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: field },
      ],
      duplicateMode: 'create',
    });

    const responses: string[] = [];
    for (const field of ['title', 'phone', 'no_such_field_at_all']) {
      const id = await jobForMapping(limited.token);
      const response = await start(limited.token, id, body(field));
      expect(response.status, field).toBe(422);
      expect(response.body['error']).toMatchObject({ code: 'VALIDATION_FAILED' });
      // Nothing was queued.
      expect((await jobRow(id))['status']).toBe('awaiting_mapping');
      responses.push(
        JSON.stringify(
          (response.body['error'] as { details: { message: string }[] }).details.map((detail) =>
            detail.message.replace(field, '<field>'),
          ),
        ),
      );
    }
    // Read-only, hidden and non-existent are reported identically: the error
    // must not be a way to discover that a concealed field exists.
    expect(new Set(responses).size).toBe(1);
  });

  it('does not offer the owner to a caller whose scope is `own`, and refuses it on start', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `own-importer-${unique()}`);
    for (const action of ['read', 'create', 'update', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'own');
    }
    const rep = await userWithRole(tenantA, roleId);

    const id = await jobForMapping(rep.token);
    const data = dataOf<{ targets: { key: string }[] }>(
      await request(harness, { method: 'GET', url: `/api/v1/imports/${id}`, token: rep.token }),
    );
    const keys = data.targets.map((target) => target.key);
    expect(keys).not.toContain('owner_id');
    expect(keys).not.toContain('account_id');

    const response = await start(rep.token, id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'owner_id' },
      ],
      duplicateMode: 'create',
    });
    expect(response.status).toBe(422);
    expect((await jobRow(id))['status']).toBe('awaiting_mapping');
  });

  it.each(['tenant_id', 'version', 'id', 'created_by', 'updated_by', 'deleted_at'])(
    'refuses a column mapped onto %s',
    async (field) => {
      const id = await jobForMapping(managerA.token);
      const response = await start(managerA.token, id, {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: field },
        ],
        duplicateMode: 'create',
      });
      expect(response.status).toBe(422);
      expect((await jobRow(id))['status']).toBe('awaiting_mapping');
    },
  );

  it('requires every required field to be mapped', async () => {
    const id = await jobForMapping(managerA.token);
    const response = await start(managerA.token, id, {
      mapping: [{ column: 1, field: 'email' }],
      duplicateMode: 'create',
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/Last name is required/);
  });

  it('validates the shape: columns in range and unique, fields unique, match field mapped', async () => {
    const id = await jobForMapping(managerA.token);
    const cases: Record<string, unknown>[] = [
      { mapping: [{ column: 9, field: 'last_name' }], duplicateMode: 'create' }, // out of range
      {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 0, field: 'email' },
        ],
        duplicateMode: 'create',
      },
      {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'last_name' },
        ],
        duplicateMode: 'create',
      },
      { mapping: [{ column: 0, field: 'last_name' }], duplicateMode: 'skip' }, // no match field
      { mapping: [{ column: 0, field: 'last_name' }], duplicateMode: 'skip', matchField: 'email' }, // unmapped
      {
        mapping: [{ column: 0, field: 'last_name' }],
        duplicateMode: 'skip',
        matchField: 'last_name',
      }, // not a key
      { mapping: [], duplicateMode: 'create' },
      { mapping: [{ column: 0, field: 'last_name' }], duplicateMode: 'merge' },
      { mapping: [{ column: -1, field: 'last_name' }], duplicateMode: 'create' },
    ];
    for (const body of cases) {
      const response = await start(managerA.token, id, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect((await jobRow(id))['status']).toBe('awaiting_mapping');
  });

  it('refuses unknown keys in the start body, so an ownerId cannot ride along', async () => {
    const id = await jobForMapping(managerA.token);
    for (const extra of [
      { ownerId: newId() },
      { tenantId: tenantB },
      { version: 1 },
      { status: 'completed' },
    ]) {
      const response = await start(managerA.token, id, {
        mapping: [{ column: 0, field: 'last_name' }],
        duplicateMode: 'create',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('an update-mode import needs update permission, not just create', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `no-update-${unique()}`);
    for (const action of ['read', 'create', 'import'] as const) {
      await harness.fixtures.grant(tenantA, roleId, 'contact', action, 'all');
    }
    const user = await userWithRole(tenantA, roleId);
    const id = await jobForMapping(user.token);
    const response = await start(user.token, id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 2, field: 'email' },
      ],
      duplicateMode: 'update',
      matchField: 'email',
    });
    expect(response.status).toBe(403);
  });
});

describe('start: a successful start only queues work', () => {
  const body = {
    mapping: [
      { column: 0, field: 'first_name' },
      { column: 1, field: 'last_name' },
      { column: 2, field: 'email' },
    ],
    duplicateMode: 'skip',
    matchField: 'email',
  };

  it('returns 202 with the job still in staging, never completed, and queues one event', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);

    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body,
    });

    expect(response.status).toBe(202);
    const job = dataOf<{
      status: string;
      processedRows: number;
      createdCount: number;
      mapping: unknown[];
    }>(response);
    // The UI is not blocked on the import: the request returns having done none of it.
    expect(job.status).toBe('staging');
    expect(job.processedRows).toBe(0);
    expect(job.createdCount).toBe(0);
    expect(job.mapping).toHaveLength(3);

    const events = await superuser.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and event_type = 'import.started.v1'`,
      [created!.id],
    );
    expect(events.rows[0]?.['n']).toBe(1);
    expect((await jobRow(created!.id))['started_at']).not.toBeNull();
  });

  it('refuses a second start, and a start before analysis has finished', async () => {
    const { created } = await createImport(managerA.token);
    const early = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body,
    });
    expect(early.status).toBe(409);

    await awaitMapping(created!.id);
    const first = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body,
    });
    expect(first.status).toBe(202);
    const second = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body,
    });
    expect(second.status).toBe(409);

    const events = await superuser.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and event_type = 'import.started.v1'`,
      [created!.id],
    );
    expect(events.rows[0]?.['n']).toBe(1);
  });

  it('ignores the match field when duplicates are simply created', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body: { mapping: body.mapping, duplicateMode: 'create', matchField: 'email' },
    });
    expect(response.status).toBe(202);
    expect(dataOf<{ matchField: string | null }>(response).matchField).toBeNull();
  });
});

describe('the error file link', () => {
  it('is a 409 until there is an error file, then a short-lived URL, audited', async () => {
    const { created } = await createImport(managerA.token);
    const none = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/error-file`,
      token: managerA.token,
    });
    expect(none.status).toBe(409);

    await setJob(created!.id, `error_file_key = $1`, [`tenants/${tenantA}/imports/x.errors.csv`]);
    harness.storage.put(
      `tenants/${tenantA}/imports/x.errors.csv`,
      Buffer.from('Row,Error\r\n3,bad\r\n'),
    );

    const reads = harness.storage.reads;
    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/error-file`,
      token: managerA.token,
    });
    expect(link.status).toBe(200);
    const data = dataOf<{ url: string; expiresAt: string }>(link);
    expect(Object.keys(data).sort()).toEqual(['expiresAt', 'url']);
    expect(new Date(data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1000 + 5_000,
    );
    // Served by the store, not streamed by us.
    expect(harness.storage.reads).toBe(reads);
    expect(harness.storage.simulateDownload(data.url).length).toBeGreaterThan(0);
    expect(harness.storage.issuedDownloadRequests.at(-1)).toMatchObject({
      contentType: 'text/csv',
      expiresInSeconds: 300,
    });

    const audit = await superuser.query(
      `select action, actor_id from audit_logs where tenant_id = $1 and record_id = $2 and action = 'export'`,
      [tenantA, created!.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.['actor_id']).toBe(managerA.userId);
  });

  it('an expired link stops working', async () => {
    const { created } = await createImport(managerA.token);
    const key = `tenants/${tenantA}/imports/y.errors.csv`;
    await setJob(created!.id, `error_file_key = $1`, [key]);
    harness.storage.put(key, Buffer.from('x'));
    const link = await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/error-file`,
      token: managerA.token,
    });
    const url = dataOf<{ url: string }>(link).url;

    const realNow = harness.storage.now;
    try {
      harness.storage.now = () => new Date(Date.now() + 6 * 60 * 1000);
      expect(() => harness.storage.simulateDownload(url)).toThrow(/expired/);
    } finally {
      harness.storage.now = realNow;
    }
  });
});

describe('audit', () => {
  it('records creating and starting an import against the person who did it', async () => {
    const { created } = await createImport(managerA.token, { fileName: 'audited.csv' });
    await awaitMapping(created!.id);
    await request(harness, {
      method: 'POST',
      url: `/api/v1/imports/${created!.id}/start`,
      token: managerA.token,
      body: {
        mapping: [{ column: 1, field: 'last_name' }],
        duplicateMode: 'create',
      },
    });

    // Ordered by `id`, not `occurred_at`. `occurred_at` is the database's
    // transaction start time, and the clock behind it can step backwards
    // between two requests (a VM resync does), which reorders rows that were
    // written in sequence. The id is a UUIDv7 minted in the API process, which
    // is monotonic however the clock behaves, so it is the order things
    // actually happened in.
    const entries = await superuser.query(
      `select action, actor_id, changes from audit_logs
       where tenant_id = $1 and record_id = $2 and action = 'import' order by id`,
      [tenantA, created!.id],
    );
    expect(entries.rows).toHaveLength(2);
    expect(entries.rows.every((row) => row.actor_id === managerA.userId)).toBe(true);
    expect(entries.rows[0]?.['changes']).toMatchObject({ fileName: { new: 'audited.csv' } });
    expect(entries.rows[1]?.['changes']).toMatchObject({ mappedFields: { new: ['last_name'] } });
  });
});

describe('check: the same file and mapping, nothing imported (ADR-0068)', () => {
  const body = {
    mapping: [
      { column: 1, field: 'last_name' },
      { column: 2, field: 'email' },
    ],
    duplicateMode: 'skip',
    matchField: 'email',
  };
  const check = (token: string, id: string, payload: Record<string, unknown> = body) =>
    request(harness, { method: 'POST', url: `/api/v1/imports/${id}/check`, token, body: payload });

  it('returns 202 with a job of its own, leaves the import waiting, and keeps the file', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);

    const response = await check(managerA.token, created!.id);
    expect(response.status).toBe(202);
    const checkJob = dataOf<{ id: string; status: string; dryRun: boolean }>(response);
    expect(checkJob).toMatchObject({ status: 'staging', dryRun: true });
    expect(checkJob.id).not.toBe(created!.id);

    // The import being checked is untouched, so it can be changed, checked again, or started.
    expect((await jobRow(created!.id))['status']).toBe('awaiting_mapping');
    expect((await jobRow(created!.id))['dry_run']).toBe(false);
    // Same file, same stored object.
    expect((await jobRow(checkJob.id))['storage_key']).toBe(
      (await jobRow(created!.id))['storage_key'],
    );

    const events = await superuser.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and event_type = 'import.started.v1'`,
      [checkJob.id],
    );
    expect(events.rows[0]?.['n']).toBe(1);

    // It is audited as a check, with the job it checked.
    const audit = await superuser.query(
      `select changes from audit_logs where tenant_id = $1 and record_id = $2 and action = 'import'`,
      [tenantA, checkJob.id],
    );
    expect(audit.rows[0]?.['changes']).toMatchObject({
      dryRun: { new: true },
      checkedJobId: { new: created!.id },
    });
  });

  it('is not listed among the person’s imports', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);
    const checkJob = dataOf<{ id: string }>(await check(managerA.token, created!.id));

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/imports?limit=100',
      token: managerA.token,
    });
    const ids = (list.body['data'] as { id: string }[]).map((job) => job.id);
    expect(ids).toContain(created!.id);
    expect(ids).not.toContain(checkJob.id);
  });

  it('refuses what start refuses: a column onto a field that cannot be imported', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);
    const refused = await check(managerA.token, created!.id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'tenant_id' },
      ],
      duplicateMode: 'create',
    });
    expect(refused.status).toBe(422);
    const rows = await superuser.query(
      `select count(*)::int as n from import_jobs where tenant_id = $1 and dry_run`,
      [tenantA],
    );
    // No check job was made for the refused mapping.
    const before = Number(rows.rows[0]?.['n']);
    await check(managerA.token, created!.id, {
      mapping: [{ column: 0, field: 'tenant_id' }],
      duplicateMode: 'create',
    });
    const after = await superuser.query(
      `select count(*)::int as n from import_jobs where tenant_id = $1 and dry_run`,
      [tenantA],
    );
    expect(Number(after.rows[0]?.['n'])).toBe(before);
  });

  it('refuses a caller with no import grant, another person’s job, and a job not yet mapped', async () => {
    const { created } = await createImport(managerA.token);
    expect((await check(managerA.token, created!.id)).status).toBe(409);

    await awaitMapping(created!.id);
    // Someone with no import grant never owns a job, so the job is simply not theirs: 404, the same
    // answer `start` gives, and nothing says whether the job exists.
    expect((await check(repA.token, created!.id)).status).toBe(404);
    expect((await check(readOnlyA.token, created!.id)).status).toBe(404);
    // Someone else in the workspace gets "not found", as for any other route on a job.
    const colleague = await userWithRole(tenantA, roles.get('Manager')!);
    expect((await check(colleague.token, created!.id)).status).toBe(404);
  });

  it('does not reach into another workspace', async () => {
    const { created } = await createImport(managerA.token);
    await awaitMapping(created!.id);
    expect((await check(adminB.token, created!.id)).status).toBe(404);
  });
});
