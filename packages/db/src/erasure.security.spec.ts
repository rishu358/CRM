import { ERASED_PLACEHOLDER, newId } from '@crm/core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDbClient, withTenant, type DbClient } from './client.js';
import { redactAuditDiffs } from './data-rights/index.js';
import { Fixtures } from './testing/fixtures.js';
import { captureDbError, INSUFFICIENT_PRIVILEGE } from './testing/errors.js';

/**
 * The erasure path, at the level where its guarantees actually live
 * (MVP_SPEC M11, ADR-0032, CLAUDE.md §5.10).
 *
 * ADR-0032 resolves a conflict — an append-only audit log, and an obligation to
 * stop personal values being readable — by giving the capability to a fifth
 * database role rather than widening `crm_app`. Everything that makes that
 * narrow is enforced by **Postgres**, not by our code, so this suite asserts it
 * against the database directly rather than through a handler:
 *
 *   1. `crm_app` and `crm_worker` cannot UPDATE or DELETE an audit row at all;
 *   2. `crm_erasure` can change **only** the `changes` column;
 *   3. `crm_erasure` can touch a row only while that subject's erasure request
 *      says `processing` — outside the window it reads and writes nothing;
 *   4. it cannot cross a tenant boundary, with or without a window;
 *   5. the redaction keeps the row and its structure, and replaces the personal
 *      values with `[erased]`.
 *
 * If any of these stops holding, the right response is to stop and rethink the
 * design, not to adjust the test.
 */
let appClient: DbClient;
let workerClient: DbClient;
let erasureClient: DbClient;
let rawSuperuser: pg.Pool;
let fixtures: Fixtures;

let tenantA: string;
let tenantB: string;
let actorId: string;
let subjectA: string;
let subjectB: string;
let auditRowA: string;
let requestA: string;

/** An audit row with a diff holding personal and non-personal values. */
async function writeAudit(tenantId: string, recordId: string): Promise<string> {
  const id = newId();
  await rawSuperuser.query(
    `insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id, changes, ip_address)
     values ($1, $2, $3, 'update', 'contact', $4, $5::jsonb, '203.0.113.9')`,
    [
      id,
      tenantId,
      actorId,
      recordId,
      JSON.stringify({
        lastName: { old: 'Rao', new: 'Rao-Patel' },
        email: { old: 'old@example.com', new: 'new@example.com' },
        ownerId: { old: null, new: actorId },
        customFields: { old: { pan: 'ABCDE1234F' }, new: { pan: 'ZZZZZ9999Z' } },
      }),
    ],
  );
  return id;
}

async function writeRequest(
  tenantId: string,
  subjectRecordId: string,
  status: string,
): Promise<string> {
  const id = newId();
  await rawSuperuser.query(
    `insert into erasure_requests (id, tenant_id, subject_object_type, subject_record_id, status)
     values ($1, $2, 'contact', $3, $4)`,
    [id, tenantId, subjectRecordId, status],
  );
  return id;
}

async function changesOf(id: string): Promise<Record<string, { old?: unknown; new?: unknown }>> {
  const row = (
    await rawSuperuser.query<{ changes: Record<string, { old?: unknown; new?: unknown }> }>(
      'select changes from audit_logs where id = $1',
      [id],
    )
  ).rows[0];
  if (row === undefined) throw new Error(`No audit row ${id}`);
  return row.changes;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  appClient = createDbClient({ connectionString: urls.app, maxConnections: 2 });
  workerClient = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  erasureClient = createDbClient({ connectionString: urls.erasure, maxConnections: 2 });
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 3 });
  fixtures = new Fixtures(rawSuperuser);

  tenantA = (await fixtures.createTenant({ name: 'Erasure A' })).tenantId;
  tenantB = (await fixtures.createTenant({ name: 'Erasure B' })).tenantId;
  const roleId = await fixtures.createRole(tenantA, 'Erasure role');
  actorId = (await fixtures.createUser(tenantA, roleId)).userId;
});

afterAll(async () => {
  await Promise.all([
    appClient.close(),
    workerClient.close(),
    erasureClient.close(),
    rawSuperuser.end(),
  ]);
});

beforeEach(async () => {
  subjectA = newId();
  subjectB = newId();
  auditRowA = await writeAudit(tenantA, subjectA);
  requestA = await writeRequest(tenantA, subjectA, 'processing');
});

describe('the application roles cannot rewrite history (CLAUDE.md §5.10)', () => {
  it('crm_app has no UPDATE on audit_logs, window or no window', async () => {
    const error = await captureDbError(() =>
      withTenant(appClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
        tx.execute(sql`update audit_logs set changes = '{}'::jsonb where id = ${auditRowA}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);

    // Unchanged.
    expect((await changesOf(auditRowA))['email']).toEqual({
      old: 'old@example.com',
      new: 'new@example.com',
    });
  });

  it('crm_app has no DELETE on audit_logs', async () => {
    const error = await captureDbError(() =>
      withTenant(appClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
        tx.execute(sql`delete from audit_logs where id = ${auditRowA}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('crm_worker cannot either — the erasure job does not use its own connection for this', async () => {
    const error = await captureDbError(() =>
      withTenant(workerClient.db, { tenantId: tenantA, userId: null }, (tx) =>
        tx.execute(sql`update audit_logs set changes = '{}'::jsonb where id = ${auditRowA}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('crm_erasure is narrowed by column grant (ADR-0032a)', () => {
  it('cannot change who did what, when, or to which record', async () => {
    for (const statement of [
      sql`update audit_logs set action = 'create' where id = ${auditRowA}::uuid`,
      sql`update audit_logs set actor_id = null where id = ${auditRowA}::uuid`,
      sql`update audit_logs set occurred_at = now() where id = ${auditRowA}::uuid`,
      sql`update audit_logs set object_type = 'lead' where id = ${auditRowA}::uuid`,
      sql`update audit_logs set record_id = ${subjectB}::uuid where id = ${auditRowA}::uuid`,
      sql`update audit_logs set ip_address = null where id = ${auditRowA}::uuid`,
    ]) {
      const error = await captureDbError(() =>
        withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
          tx.execute(statement),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('cannot insert a row, so it cannot fabricate history', async () => {
    const error = await captureDbError(() =>
      withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
        tx.execute(sql`
          insert into audit_logs (id, tenant_id, action, object_type, record_id)
          values (${newId()}::uuid, ${tenantA}::uuid, 'update', 'contact', ${subjectA}::uuid)
        `),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot delete a row', async () => {
    const error = await captureDbError(() =>
      withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
        tx.execute(sql`delete from audit_logs where id = ${auditRowA}::uuid`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot read or write business tables at all', async () => {
    for (const statement of [
      sql`select 1 from contacts limit 1`,
      sql`select 1 from deals limit 1`,
      sql`select 1 from users limit 1`,
    ]) {
      const error = await captureDbError(() =>
        withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
          tx.execute(statement),
        ),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe('crm_erasure is narrowed by policy to an open window (ADR-0032c)', () => {
  it('redacts while the request is processing', async () => {
    const redacted = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );
    expect(redacted).toBe(1);

    const changes = await changesOf(auditRowA);
    expect(changes['lastName']).toEqual({
      old: ERASED_PLACEHOLDER,
      new: ERASED_PLACEHOLDER,
    });
    expect(changes['email']).toEqual({ old: ERASED_PLACEHOLDER, new: ERASED_PLACEHOLDER });
    expect(changes['customFields']).toEqual({
      old: ERASED_PLACEHOLDER,
      new: ERASED_PLACEHOLDER,
    });
    // Not personal: `owner_id` is which rep holds the record, which is the
    // company's own information about its own staffing.
    expect(changes['ownerId']).toEqual({ old: null, new: actorId });
    expect(JSON.stringify(changes)).not.toContain('example.com');
    expect(JSON.stringify(changes)).not.toContain('ABCDE1234F');
  });

  it('keeps the row, its action, its actor, its time and its address', async () => {
    const before = (
      await rawSuperuser.query<{ action: string; actor_id: string; occurred_at: Date }>(
        'select action, actor_id, occurred_at from audit_logs where id = $1',
        [auditRowA],
      )
    ).rows[0]!;

    await withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
      redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );

    const after = (
      await rawSuperuser.query<{
        action: string;
        actor_id: string;
        occurred_at: Date;
        ip_address: string;
        record_id: string;
      }>(
        'select action, actor_id, occurred_at, ip_address, record_id from audit_logs where id = $1',
        [auditRowA],
      )
    ).rows[0]!;

    expect(after.action).toBe(before.action);
    expect(after.actor_id).toBe(before.actor_id);
    expect(after.occurred_at.getTime()).toBe(before.occurred_at.getTime());
    expect(after.ip_address).toBe('203.0.113.9');
    expect(after.record_id).toBe(subjectA);
  });

  it('changes nothing once the request is completed', async () => {
    await rawSuperuser.query(`update erasure_requests set status = 'completed' where id = $1`, [
      requestA,
    ]);

    const redacted = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );

    expect(redacted).toBe(0);
    expect((await changesOf(auditRowA))['email']).toEqual({
      old: 'old@example.com',
      new: 'new@example.com',
    });
  });

  it('changes nothing for a subject with no request at all', async () => {
    const unrelated = await writeAudit(tenantA, subjectB);

    const redacted = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantA, 'contact', subjectB),
    );

    expect(redacted).toBe(0);
    expect((await changesOf(unrelated))['email']).toEqual({
      old: 'old@example.com',
      new: 'new@example.com',
    });
  });

  it('changes nothing while the request is only pending', async () => {
    const pendingSubject = newId();
    const row = await writeAudit(tenantA, pendingSubject);
    await writeRequest(tenantA, pendingSubject, 'pending');

    const redacted = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantA, 'contact', pendingSubject),
    );

    expect(redacted).toBe(0);
    expect((await changesOf(row))['email']).toBeDefined();
  });

  it('cannot even read a row outside its window', async () => {
    await rawSuperuser.query(`update erasure_requests set status = 'completed' where id = $1`, [
      requestA,
    ]);

    const rows = await withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
      tx.execute(sql`select id from audit_logs where id = ${auditRowA}::uuid`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('tenant isolation holds for the erasure role too (CLAUDE.md §5.1)', () => {
  it("cannot redact another tenant's rows, even with a window open in its own", async () => {
    const theirRow = await writeAudit(tenantB, subjectB);
    await writeRequest(tenantB, subjectB, 'processing');

    // Connected to tenant A, asked to redact tenant B's subject.
    const redacted = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantB, 'contact', subjectB),
    );

    expect(redacted).toBe(0);
    expect((await changesOf(theirRow))['email']).toEqual({
      old: 'old@example.com',
      new: 'new@example.com',
    });
  });

  it('sees nothing at all with no tenant context', async () => {
    const rows = await erasureClient.db.transaction((tx) =>
      tx.execute(sql`select id from audit_logs limit 1`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('the redaction is idempotent (ADR-0006)', () => {
  it('a second pass changes nothing further', async () => {
    const first = await withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
      redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );
    const afterFirst = await changesOf(auditRowA);

    const second = await withTenant(
      erasureClient.db,
      { tenantId: tenantA, userId: actorId },
      (tx) => redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );

    expect(first).toBe(1);
    // Still matched — the keys are still present — but the values are the same.
    expect(second).toBe(1);
    expect(await changesOf(auditRowA)).toEqual(afterFirst);
  });

  it('leaves a row with no personal keys untouched', async () => {
    const id = newId();
    await rawSuperuser.query(
      `insert into audit_logs (id, tenant_id, action, object_type, record_id, changes)
       values ($1, $2, 'update', 'contact', $3, '{"ownerId": {"old": null, "new": "x"}}'::jsonb)`,
      [id, tenantA, subjectA],
    );

    await withTenant(erasureClient.db, { tenantId: tenantA, userId: actorId }, (tx) =>
      redactAuditDiffs(tx, tenantA, 'contact', subjectA),
    );

    expect(await changesOf(id)).toEqual({ ownerId: { old: null, new: 'x' } });
  });
});
