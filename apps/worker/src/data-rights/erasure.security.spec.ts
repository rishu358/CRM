import { ERASED_PLACEHOLDER, newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  startDataRightsHarness,
  type DataRightsHarness,
} from '../testing/data-rights-harness.js';

/**
 * Erasure, end to end through the relay (MVP_SPEC M11, ADR-0032).
 *
 * `packages/db/src/erasure.security.spec.ts` proves what the database permits.
 * This proves what the job actually does with it:
 *
 *   - personal fields deleted or pseudonymised, custom fields emptied;
 *   - **audit diffs redacted, the rows kept**, with values replaced by
 *     `[erased]` and the structure of history — who, what, when — untouched;
 *   - the redaction window opened and **closed again**, which is the one state
 *     this design must not leave behind;
 *   - idempotent under at-least-once delivery;
 *   - a deployment with no erasure role fails the request loudly rather than
 *     erasing the record and leaving its history readable.
 */
let harness: DataRightsHarness;

/**
 * Rows from the superuser pool, named.
 *
 * `typedPool` returns `Record<string, unknown>[]` on purpose — `pg`'s default
 * `any[]` silently switches the type checker off for everything a test reads
 * back. This narrows at the call site instead, so each column still has to be
 * named explicitly.
 */
async function rowsOf<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  return (await harness.pool.query(text, values)).rows as T[];
}
let owner: string;

async function makeContact(lastName: string): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into contacts (id, tenant_id, first_name, last_name, email, phone, whatsapp, title,
                           address, consent, custom_fields)
     values ($1, $2, 'Priya', $3, $4, '+919876543210', '+919876543210', 'Head of Ops',
             '{"city": "Pune"}'::jsonb, '{"email": {"status": "granted"}}'::jsonb,
             '{"pan": "ABCDE1234F"}'::jsonb)`,
    [id, harness.tenantId, lastName, `${newId().slice(0, 8)}@example.com`],
  );
  return id;
}

async function writeAudit(recordId: string, changes: Record<string, unknown>): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id, changes, ip_address)
     values ($1, $2, $3, 'update', 'contact', $4, $5::jsonb, '203.0.113.7')`,
    [id, harness.tenantId, owner, recordId, JSON.stringify(changes)],
  );
  return id;
}

async function contactRow(id: string): Promise<Record<string, unknown>> {
  const rows = (await harness.pool.query('select * from contacts where id = $1', [id]))
    .rows as Record<string, unknown>[];
  const row = rows[0];
  if (row === undefined) throw new Error(`No contact ${id}`);
  return row;
}

async function auditChanges(id: string): Promise<Record<string, { old?: unknown; new?: unknown }>> {
  const row = (
    await rowsOf<{ changes: Record<string, { old?: unknown; new?: unknown }> }>(
      'select changes from audit_logs where id = $1',
      [id],
    )
  )[0];
  if (row === undefined) throw new Error(`No audit row ${id}`);
  return row.changes;
}

beforeAll(async () => {
  harness = await startDataRightsHarness(inject('dbUrls'), { name: 'Erasure worker' });
  owner = await harness.user('Owner');
});

afterAll(async () => {
  await harness.close();
});

describe('erasing a person (MVP_SPEC M11)', () => {
  it('deletes or pseudonymises every personal field and empties the custom ones', async () => {
    const subject = await makeContact('Deshmukh');

    const requestId = await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const row = await contactRow(subject);
    expect(row['first_name']).toBeNull();
    expect(row['email']).toBeNull();
    expect(row['phone']).toBeNull();
    expect(row['whatsapp']).toBeNull();
    expect(row['title']).toBeNull();
    expect(row['address']).toEqual({});
    expect(row['consent']).toEqual({});
    expect(row['custom_fields']).toEqual({});
    // `last_name` is NOT NULL, so it is pseudonymised rather than deleted —
    // a record with no name at all is an unreadable hole in every list the
    // person appears in.
    expect(row['last_name']).toBe(ERASED_PLACEHOLDER);
    // And it goes into the Bin: an erased record is not a usable record.
    expect(row['deleted_at']).not.toBeNull();

    const request = await harness.erasure(requestId);
    expect(request.status).toBe('completed');
    expect(request.recordsErased).toBe(1);
  });

  it('redacts the audit diffs and keeps the rows', async () => {
    const subject = await makeContact('Kulkarni');
    const auditRow = await writeAudit(subject, {
      lastName: { old: 'Rao', new: 'Kulkarni' },
      email: { old: 'erase.old@example.com', new: 'erase.new@example.com' },
      ownerId: { old: null, new: owner },
    });

    const requestId = await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const changes = await auditChanges(auditRow);
    expect(changes['email']).toEqual({ old: ERASED_PLACEHOLDER, new: ERASED_PLACEHOLDER });
    expect(changes['lastName']).toEqual({ old: ERASED_PLACEHOLDER, new: ERASED_PLACEHOLDER });
    // Not personal data about the subject: which rep holds the record is the
    // company's own information about its own staffing.
    expect(changes['ownerId']).toEqual({ old: null, new: owner });

    const kept = (
      await rowsOf<{
        action: string;
        actor_id: string;
        ip_address: string;
        record_id: string;
      }>('select action, actor_id, ip_address, record_id from audit_logs where id = $1', [auditRow])
    )[0]!;
    expect(kept.action).toBe('update');
    expect(kept.actor_id).toBe(owner);
    expect(kept.ip_address).toBe('203.0.113.7');
    expect(kept.record_id).toBe(subject);

    const request = await harness.erasure(requestId);
    expect(request.auditRowsRedacted).toBe(1);
  });

  it('reports counts, not values, in its own audit entry', async () => {
    const subject = await makeContact('Iyer');
    await writeAudit(subject, { email: { new: 'never.in.audit@example.com' } });

    await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const rows = await rowsOf<{ action: string; changes: unknown }>(
      `select action, changes from audit_logs where record_id = $1`,
      [subject],
    );
    const redactEntry = rows.find((row) => row.action === 'redact');
    expect(redactEntry).toBeDefined();
    // The erasure's own entry must not become the last place the data lives.
    expect(JSON.stringify(rows)).not.toContain('never.in.audit@example.com');
    expect(JSON.stringify(redactEntry?.changes)).toContain('auditRowsRedacted');
  });

  it('closes the redaction window when it finishes', async () => {
    const subject = await makeContact('Window');
    const requestId = await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const request = await harness.erasure(requestId);
    expect(request.status).toBe('completed');
    expect(request.completedAt).not.toBeNull();

    // With the request completed, the erasure role can no longer see the rows
    // at all — asserted directly in `packages/db/src/erasure.security.spec.ts`.
    const stillProcessing = await harness.pool.query(
      `select 1 from erasure_requests where id = $1 and status = 'processing'`,
      [requestId],
    );
    expect(stillProcessing.rows).toHaveLength(0);
  });

  it('publishes a delete event so search and the timeline hear about it', async () => {
    const subject = await makeContact('Projected');
    await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const events = await rowsOf<{ event_type: string }>(
      'select event_type from outbox_events where record_id = $1',
      [subject],
    );
    expect(events.map((row) => row.event_type)).toContain('contact.deleted.v1');
  });
});

describe('idempotency (ADR-0006)', () => {
  it('a redelivered request does nothing a second time', async () => {
    const subject = await makeContact('Twice');
    const auditRow = await writeAudit(subject, {
      email: { old: 'twice.old@example.com', new: 'twice.new@example.com' },
    });

    const requestId = await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    const afterFirst = await contactRow(subject);
    const changesAfterFirst = await auditChanges(auditRow);

    await harness.pool.query(
      `insert into outbox_events (id, tenant_id, event_type, object_type, record_id, actor_id)
       values ($1, $2, 'erasure.requested.v1', 'erasure_request', $3, $4)`,
      [newId(), harness.tenantId, requestId, owner],
    );
    await harness.drain();

    expect(await contactRow(subject)).toEqual(afterFirst);
    expect(await auditChanges(auditRow)).toEqual(changesAfterFirst);

    const request = await harness.erasure(requestId);
    expect(request.status).toBe('completed');
    expect(request.recordsErased).toBe(1);
  });
});

describe('the requester is judged when the job runs', () => {
  it('refuses an erasure whose requester lost the capability in between', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Transient DPO ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grant(harness.tenantId, roleId, 'data_subject', 'delete', 'all');
    const user = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    const subject = await makeContact('Protected');
    const requestId = await harness.requestErasure({
      userId: user,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });

    await harness.pool.query(
      `delete from role_permissions where role_id = $1 and object_type = 'data_subject'`,
      [roleId],
    );
    await harness.drain();

    const request = await harness.erasure(requestId);
    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/no longer has permission/i);

    // Nothing was erased.
    const row = await contactRow(subject);
    expect(row['last_name']).toBe('Protected');
    expect(row['email']).not.toBeNull();
  });
});

describe('a deployment without the erasure role', () => {
  it('fails the request loudly rather than erasing without redacting', async () => {
    // The failure mode that matters: erasing the record while leaving its
    // history readable would be a compliance failure reported as a success.
    const unconfigured = await startDataRightsHarness(inject('dbUrls'), {
      name: 'No erasure role',
      withoutErasureRole: true,
    });
    try {
      const ownerThere = await unconfigured.user('Owner');
      const id = newId();
      await unconfigured.pool.query(
        `insert into contacts (id, tenant_id, last_name, email)
         values ($1, $2, 'Unconfigured', 'keep@example.com')`,
        [id, unconfigured.tenantId],
      );

      const requestId = await unconfigured.requestErasure({
        userId: ownerThere,
        subjectObjectType: 'contact',
        subjectRecordId: id,
      });
      await unconfigured.drain();

      const request = await unconfigured.erasure(requestId);
      expect(request.status).toBe('failed');
      expect(request.failureReason).toMatch(/not configured/i);

      const row = (
        await unconfigured.pool.query('select last_name, email from contacts where id = $1', [id])
      ).rows[0] as { last_name: string; email: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.last_name).toBe('Unconfigured');
      expect(row?.email).toBe('keep@example.com');
    } finally {
      await unconfigured.close();
    }
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it("does not touch another tenant's audit rows for a subject with the same id", async () => {
    const neighbour = await harness.otherTenant();
    const subject = await makeContact('Shared');

    // The same record id in the neighbour's tenant — the case a redaction that
    // forgot its tenant predicate would get wrong.
    const theirAudit = newId();
    await harness.pool.query(
      `insert into audit_logs (id, tenant_id, action, object_type, record_id, changes)
       values ($1, $2, 'update', 'contact', $3, '{"email": {"new": "neighbour@example.com"}}'::jsonb)`,
      [theirAudit, neighbour.tenantId, subject],
    );

    await harness.requestErasure({
      userId: owner,
      subjectObjectType: 'contact',
      subjectRecordId: subject,
    });
    await harness.drain();

    expect(await auditChanges(theirAudit)).toEqual({
      email: { new: 'neighbour@example.com' },
    });
  });
});
