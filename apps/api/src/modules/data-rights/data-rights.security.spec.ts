import { newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Data rights (MVP_SPEC M11, CLAUDE.md §5 and §10).
 *
 * The four mandatory suites, plus the capability matrix this module turns on.
 * The matrix is the point: four grants, deliberately separate, so that letting
 * an Admin answer a subject access request is not also letting them download the
 * whole company or erase a customer.
 *
 *   | asked for                 | needs                  | Owner | Admin | Rep |
 *   | ------------------------- | ---------------------- | ----- | ----- | --- |
 *   | audit-log archive         | `audit_log:export`     | yes   | yes   | no  |
 *   | whole-tenant archive      | `tenant_data:export`   | yes   | no    | no  |
 *   | one person's archive      | `data_subject:export`  | yes   | yes   | no  |
 *   | erase a person            | `data_subject:delete`  | yes   | no    | no  |
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

/**
 * Rows from the superuser pool, named.
 *
 * `typedPool` returns `Record<string, unknown>[]` on purpose — `pg`'s default
 * `any[]` switches the type checker off for everything a test reads back, which
 * is how an assertion ends up checking a column that does not exist. This
 * narrows at the call site instead.
 */
async function rowsOf<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  return (await superuser.query(text, values)).rows as T[];
}

let tenantA: string;
let tenantB: string;
let rolesA: ReadonlyMap<string, string>;
let ownerA: { token: string; userId: string };
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let ownerB: { token: string; userId: string };

let contactA: string;
let contactB: string;

async function userWithRole(tenantId: string, roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

async function makeContact(
  tenantId: string,
  ownerId: string | null,
  lastName = 'Sharma',
): Promise<string> {
  const id = newId();
  await superuser.query(
    `insert into contacts (id, tenant_id, owner_id, last_name, email)
     values ($1, $2, $3, $4, $5)`,
    [id, tenantId, ownerId, lastName, `${newId().slice(0, 8)}@example.com`],
  );
  return id;
}

const createExport = (token: string | undefined, body: Record<string, unknown>) =>
  request(harness, { method: 'POST', url: '/api/v1/data-exports', token, body });

const createErasure = (token: string | undefined, body: Record<string, unknown>) =>
  request(harness, { method: 'POST', url: '/api/v1/erasure-requests', token, body });

const idOf = (response: { body: Record<string, unknown> }): string =>
  (response.body['data'] as { id: string }).id;

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Rights A' })).tenantId;
  rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rights B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  ownerA = await userWithRole(tenantA, rolesA.get('Owner')!);
  adminA = await userWithRole(tenantA, rolesA.get('Admin')!);
  repA = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
  ownerB = await userWithRole(tenantB, rolesB.get('Owner')!);

  contactA = await makeContact(tenantA, adminA.userId);
  contactB = await makeContact(tenantB, ownerB.userId);
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

describe('authentication (CLAUDE.md §10d)', () => {
  it('refuses every endpoint unauthenticated', async () => {
    expect((await createExport(undefined, { kind: 'tenant' })).status).toBe(401);
    expect(
      (await createErasure(undefined, { subjectObjectType: 'contact', subjectRecordId: contactA }))
        .status,
    ).toBe(401);
    expect(
      (await request(harness, { method: 'GET', url: '/api/v1/erasure-requests' })).status,
    ).toBe(401);
  });
});

describe('the capability matrix (CLAUDE.md §5.3)', () => {
  it('lets the Owner queue a whole-tenant archive', async () => {
    const response = await createExport(ownerA.token, { kind: 'tenant' });
    expect(response.status).toBe(202);
  });

  it('refuses an Admin the whole-tenant archive', async () => {
    const response = await createExport(adminA.token, { kind: 'tenant' });
    expect(response.status).toBe(403);
  });

  it('refuses a Sales Rep every kind', async () => {
    expect((await createExport(repA.token, { kind: 'tenant' })).status).toBe(403);
    expect((await createExport(repA.token, { kind: 'audit_log' })).status).toBe(403);
    expect(
      (
        await createExport(repA.token, {
          kind: 'data_subject',
          subject: { objectType: 'contact', recordId: contactA },
        })
      ).status,
    ).toBe(403);
  });

  it('lets Owner and Admin queue an audit-log archive', async () => {
    expect((await createExport(ownerA.token, { kind: 'audit_log' })).status).toBe(202);
    expect((await createExport(adminA.token, { kind: 'audit_log' })).status).toBe(202);
  });

  it('lets Owner and Admin queue a subject archive, and refuses erasure to the Admin', async () => {
    const subject = { objectType: 'contact', recordId: contactA };
    expect((await createExport(ownerA.token, { kind: 'data_subject', subject })).status).toBe(202);
    expect((await createExport(adminA.token, { kind: 'data_subject', subject })).status).toBe(202);

    const erasure = await createErasure(adminA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: contactA,
    });
    expect(erasure.status).toBe(403);
  });

  it('refuses the audit-log archive to a role that may export it but not read it', async () => {
    // An archive of the log *is* the log; a capability to produce the file but
    // not to read the screen is the same leak with an extra step.
    const roleId = await harness.fixtures.createRole(tenantA, `Export only ${newId()}`);
    await harness.fixtures.grant(tenantA, roleId, 'audit_log', 'export', 'all');
    const exporter = await userWithRole(tenantA, roleId);

    expect((await createExport(exporter.token, { kind: 'audit_log' })).status).toBe(403);
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it("cannot name another tenant's record as a subject", async () => {
    const response = await createExport(ownerA.token, {
      kind: 'data_subject',
      subject: { objectType: 'contact', recordId: contactB },
    });
    expect(response.status).toBe(404);

    const erasure = await createErasure(ownerA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: contactB,
    });
    expect(erasure.status).toBe(404);

    // Nothing was recorded against the other tenant.
    const rows = await superuser.query(
      'select id from erasure_requests where subject_record_id = $1',
      [contactB],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("cannot fetch another tenant's archive job", async () => {
    const mine = idOf(await createExport(ownerA.token, { kind: 'tenant' }));
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/data-exports/${mine}`,
      token: ownerB.token,
    });
    expect(response.status).toBe(404);
  });

  it("does not list another tenant's erasure requests", async () => {
    const mine = idOf(
      await createErasure(ownerA.token, {
        subjectObjectType: 'contact',
        subjectRecordId: await makeContact(tenantA, adminA.userId),
      }),
    );
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/erasure-requests?limit=100',
      token: ownerB.token,
    });
    expect(response.status).toBe(200);
    expect((response.body['data'] as { id: string }[]).map((row) => row.id)).not.toContain(mine);
  });
});

describe('record scope on the subject (CLAUDE.md §10b)', () => {
  it("an archive cannot be asked for a record outside the requester's scope", async () => {
    // A role with the capability but only `own` scope on contacts: holding
    // data_subject does not make every record in the workspace addressable.
    const roleId = await harness.fixtures.createRole(tenantA, `Own-scope DPO ${newId()}`);
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'own');
    await harness.fixtures.grant(tenantA, roleId, 'data_subject', 'export', 'all');
    await harness.fixtures.grant(tenantA, roleId, 'data_subject', 'read', 'all');
    const scoped = await userWithRole(tenantA, roleId);

    const someoneElses = await makeContact(tenantA, adminA.userId);
    const theirOwn = await makeContact(tenantA, scoped.userId);

    expect(
      (
        await createExport(scoped.token, {
          kind: 'data_subject',
          subject: { objectType: 'contact', recordId: someoneElses },
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await createExport(scoped.token, {
          kind: 'data_subject',
          subject: { objectType: 'contact', recordId: theirOwn },
        })
      ).status,
    ).toBe(202);
  });
});

describe('erasure requests (MVP_SPEC M11)', () => {
  it('records the request, audits it, and queues the job', async () => {
    const subject = await makeContact(tenantA, adminA.userId);
    const response = await createErasure(ownerA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: subject,
      reason: 'Data subject asked under DPDP §12',
    });
    expect(response.status).toBe(202);

    const row = (
      await rowsOf<{ status: string; reason: string; created_by: string }>(
        'select status, reason, created_by from erasure_requests where id = $1',
        [idOf(response)],
      )
    )[0]!;
    expect(row.status).toBe('pending');
    expect(row.created_by).toBe(ownerA.userId);

    const audit = await rowsOf<{ action: string; changes: unknown }>(
      `select action, changes from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantA, idOf(response)],
    );
    expect(audit.map((row) => row.action)).toContain('erase');

    const outbox = await rowsOf<{ event_type: string }>(
      'select event_type from outbox_events where record_id = $1',
      [idOf(response)],
    );
    expect(outbox.map((row) => row.event_type)).toContain('erasure.requested.v1');
  });

  it('refuses a second in-flight request for the same person', async () => {
    const subject = await makeContact(tenantA, adminA.userId);
    expect(
      (
        await createErasure(ownerA.token, {
          subjectObjectType: 'contact',
          subjectRecordId: subject,
        })
      ).status,
    ).toBe(202);

    const second = await createErasure(ownerA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    expect(second.status).toBe(409);
  });

  it('can be asked for a record already in the Recycle Bin', async () => {
    const subject = await makeContact(tenantA, adminA.userId);
    await superuser.query('update contacts set deleted_at = now() where id = $1', [subject]);

    const response = await createErasure(ownerA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    expect(response.status).toBe(202);
  });

  it('refuses a subject type that is not a person', async () => {
    const response = await createErasure(ownerA.token, {
      subjectObjectType: 'account',
      subjectRecordId: newId(),
    });
    expect(response.status).toBe(422);
  });
});

describe('input validation (CLAUDE.md §5.6)', () => {
  it('rejects unknown keys', async () => {
    const response = await createExport(ownerA.token, { kind: 'tenant', tenantId: tenantB });
    expect(response.status).toBe(422);
  });

  it('requires a subject for a data-subject archive', async () => {
    expect((await createExport(ownerA.token, { kind: 'data_subject' })).status).toBe(422);
  });

  it('refuses CSV for an archive that is a graph', async () => {
    const response = await createExport(ownerA.token, { kind: 'tenant', format: 'csv' });
    expect(response.status).toBe(422);
  });

  it('caps the erasure reason', async () => {
    const response = await createErasure(ownerA.token, {
      subjectObjectType: 'contact',
      subjectRecordId: contactA,
      reason: 'x'.repeat(501),
    });
    expect(response.status).toBe(422);
  });
});

describe('download links (CLAUDE.md §5.12)', () => {
  it('refuses a link before the archive is ready, and issues one after', async () => {
    const id = idOf(await createExport(ownerA.token, { kind: 'tenant' }));

    const early = await request(harness, {
      method: 'POST',
      url: `/api/v1/data-exports/${id}/download`,
      token: ownerA.token,
    });
    expect(early.status).toBe(409);

    const key = (
      await rowsOf<{ storage_key: string }>(
        'select storage_key from data_export_jobs where id = $1',
        [id],
      )
    )[0]!.storage_key;
    harness.storage.put(key, Buffer.from('{"kind":"tenant"}'));
    await superuser.query(
      `update data_export_jobs set status = 'completed', row_count = 1, finished_at = now() where id = $1`,
      [id],
    );

    const ready = await request(harness, {
      method: 'POST',
      url: `/api/v1/data-exports/${id}/download`,
      token: ownerA.token,
    });
    expect(ready.status).toBe(200);
    expect((ready.body['data'] as { url: string }).url).toMatch(/^memory:\/\/download\//);
    // The API signed a URL and nothing else: it never read or wrote the file's
    // bytes (CLAUDE.md §5.12). `put` above is the test playing the worker.
    expect(harness.storage.reads).toBe(0);
    expect(harness.storage.writes).toBe(0);

    // Issuing the link is itself audited: it is the moment the data leaves.
    const audit = await superuser.query(
      `select changes from audit_logs where record_id = $1 and action = 'export'`,
      [id],
    );
    const downloads = (audit.rows as { changes: Record<string, { new?: unknown }> | null }[]).map(
      (row) => row.changes?.['download']?.new,
    );
    expect(downloads).toContain('link issued');
  });

  it('refuses a link to someone who is not the person who asked', async () => {
    const id = idOf(await createExport(ownerA.token, { kind: 'audit_log' }));
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/data-exports/${id}/download`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
  });
});

describe('idempotency (CLAUDE.md §6)', () => {
  it('returns the same job for a repeated Idempotency-Key', async () => {
    const headers = { 'idempotency-key': `archive-${newId()}` };
    const first = await request(harness, {
      method: 'POST',
      url: '/api/v1/data-exports',
      token: ownerA.token,
      headers,
      body: { kind: 'tenant' },
    });
    const second = await request(harness, {
      method: 'POST',
      url: '/api/v1/data-exports',
      token: ownerA.token,
      headers,
      body: { kind: 'tenant' },
    });

    expect(first.status).toBe(202);
    expect(idOf(second)).toBe(idOf(first));
  });
});
