import { newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startDataRightsHarness, type DataRightsHarness } from '../testing/data-rights-harness.js';

/**
 * Data-rights archives, against real data (MVP_SPEC M11, CLAUDE.md §5).
 *
 * The API suite proves who may *ask* for an archive. This one proves what ends
 * up **in the file**, which is where the interesting failures are:
 *
 *   - an audit-log archive must obey field permissions exactly as the viewer
 *     does. MVP_SPEC M3 names audit diffs, and an export that bypassed the
 *     filter would be the same leak with an extra step;
 *   - a whole-tenant archive must contain only that tenant's data;
 *   - the capability is re-checked when the job runs, not only when it was
 *     asked for;
 *   - every cell of the CSV is escaped against formula injection
 *     (CLAUDE.md §5.11).
 */
let harness: DataRightsHarness;
let neighbour: { tenantId: string; roleIds: ReadonlyMap<string, string> };
let owner: string;

async function makeContact(options: {
  tenantId?: string;
  lastName: string;
  email?: string;
}): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into contacts (id, tenant_id, last_name, email) values ($1, $2, $3, $4)`,
    [
      id,
      options.tenantId ?? harness.tenantId,
      options.lastName,
      options.email ?? `${newId().slice(0, 8)}@example.com`,
    ],
  );
  return id;
}

async function writeAudit(options: {
  tenantId?: string;
  objectType?: string;
  recordId: string;
  changes: Record<string, unknown>;
  actorId?: string | null;
}): Promise<string> {
  const id = newId();
  await harness.pool.query(
    `insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id, changes)
     values ($1, $2, $3, 'update', $4, $5, $6::jsonb)`,
    [
      id,
      options.tenantId ?? harness.tenantId,
      options.actorId ?? null,
      options.objectType ?? 'contact',
      options.recordId,
      JSON.stringify(options.changes),
    ],
  );
  return id;
}

/** Run an archive to completion and return the file's text. */
async function produce(options: {
  userId: string;
  kind: 'audit_log' | 'tenant' | 'data_subject';
  format?: 'json' | 'csv';
  params?: Record<string, unknown>;
  tenantId?: string;
}): Promise<{ text: string; status: string; failureReason: string | null }> {
  const jobId = await harness.requestArchive(options);
  await harness.drain();
  const job = await harness.archive(jobId);
  return {
    text: job.status === 'completed' ? harness.readText(job.storageKey) : '',
    status: job.status,
    failureReason: job.failureReason,
  };
}

beforeAll(async () => {
  harness = await startDataRightsHarness(inject('dbUrls'), { name: 'Archives' });
  neighbour = await harness.otherTenant();
  owner = await harness.user('Owner');
});

afterAll(async () => {
  await harness.close();
});

describe('the audit-log archive obeys field permissions (MVP_SPEC M3)', () => {
  it('omits a hidden field and its values from the file', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Blind archivist ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grantAll(harness.tenantId, roleId, 'contact', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'read', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'export', 'all');
    await harness.fixtures.setFieldPermission(
      harness.tenantId,
      roleId,
      'contact',
      'email',
      'hidden',
    );
    const blind = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    const contact = await makeContact({ lastName: 'Archived' });
    await writeAudit({
      recordId: contact,
      changes: {
        lastName: { old: 'Rao', new: 'Rao-Patel' },
        email: { old: 'file.old@example.com', new: 'file.new@example.com' },
      },
    });

    const blindFile = await produce({ userId: blind, kind: 'audit_log', format: 'json' });
    expect(blindFile.status).toBe('completed');
    expect(blindFile.text).not.toContain('file.old@example.com');
    expect(blindFile.text).not.toContain('file.new@example.com');
    expect(blindFile.text).toContain('Rao-Patel');

    // The same archive, asked for by somebody who may read the field.
    const ownerFile = await produce({ userId: owner, kind: 'audit_log', format: 'json' });
    expect(ownerFile.text).toContain('file.new@example.com');
  });

  it('omits a hidden custom field from inside the customFields blob', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Custom archivist ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grantAll(harness.tenantId, roleId, 'contact', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'read', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'export', 'all');
    await harness.fixtures.setFieldPermission(
      harness.tenantId,
      roleId,
      'contact',
      'pan_number',
      'hidden',
    );
    const blind = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    const contact = await makeContact({ lastName: 'CustomArchived' });
    await writeAudit({
      recordId: contact,
      changes: {
        customFields: {
          old: { segment: 'SMB', pan_number: 'FILE1234F' },
          new: { segment: 'Enterprise', pan_number: 'FILE9999Z' },
        },
      },
    });

    const file = await produce({ userId: blind, kind: 'audit_log', format: 'json' });
    expect(file.text).not.toContain('FILE1234F');
    expect(file.text).not.toContain('FILE9999Z');
    expect(file.text).toContain('Enterprise');
  });

  it('leaves out rows about an object type the requester cannot read', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Contacts archivist ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grantAll(harness.tenantId, roleId, 'contact', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'read', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'export', 'all');
    const limited = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    await writeAudit({
      objectType: 'deal',
      recordId: newId(),
      changes: { name: { old: 'Old deal', new: 'SecretDealName' } },
    });

    const file = await produce({ userId: limited, kind: 'audit_log', format: 'json' });
    expect(file.text).not.toContain('SecretDealName');
  });

  it('escapes every CSV cell against formula injection (CLAUDE.md §5.11)', async () => {
    const contact = await makeContact({ lastName: 'CsvCase' });
    await writeAudit({
      recordId: contact,
      changes: { lastName: { old: 'Safe', new: '=cmd|calc!A1' } },
    });

    const file = await produce({ userId: owner, kind: 'audit_log', format: 'csv' });
    expect(file.status).toBe('completed');
    // The payload survives as data; it no longer starts a formula.
    expect(file.text).toContain('cmd|calc!A1');
    for (const line of file.text.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(cell.replace(/^"/, '').startsWith('=')).toBe(false);
      }
    }
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it('a whole-tenant archive contains only that tenant data', async () => {
    const mine = await makeContact({ lastName: 'BelongsToMe' });
    const theirs = await makeContact({
      tenantId: neighbour.tenantId,
      lastName: 'BelongsToNeighbour',
    });

    const file = await produce({ userId: owner, kind: 'tenant', format: 'json' });
    expect(file.status).toBe('completed');
    expect(file.text).toContain(mine);
    expect(file.text).toContain('BelongsToMe');
    expect(file.text).not.toContain(theirs);
    expect(file.text).not.toContain('BelongsToNeighbour');
    expect(file.text).not.toContain(neighbour.tenantId);
  });

  it("an audit-log archive contains only that tenant's rows", async () => {
    await writeAudit({
      tenantId: neighbour.tenantId,
      recordId: newId(),
      changes: { lastName: { new: 'NeighbourAuditValue' } },
    });

    const file = await produce({ userId: owner, kind: 'audit_log', format: 'json' });
    expect(file.text).not.toContain('NeighbourAuditValue');
  });
});

describe('the capability is re-checked when the job runs (ADR-0029)', () => {
  it('fails an archive whose requester lost the capability in between', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Transient owner ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grant(harness.tenantId, roleId, 'tenant_data', 'export', 'all');
    const user = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    const jobId = await harness.requestArchive({ userId: user, kind: 'tenant' });

    // Revoked after the request, before the worker reaches it.
    await harness.pool.query(
      `delete from role_permissions where role_id = $1 and object_type = 'tenant_data'`,
      [roleId],
    );

    await harness.drain();
    const job = await harness.archive(jobId);

    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/no longer have permission/i);
    expect(harness.storage.has(job.storageKey)).toBe(false);
  });

  it('fails an audit-log archive for a requester who may export but no longer read', async () => {
    const roleId = await harness.fixtures.createRole(
      harness.tenantId,
      `Lost reader ${newId().slice(0, 8)}`,
    );
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'read', 'all');
    await harness.fixtures.grant(harness.tenantId, roleId, 'audit_log', 'export', 'all');
    const user = (await harness.fixtures.createUser(harness.tenantId, roleId)).userId;

    const jobId = await harness.requestArchive({ userId: user, kind: 'audit_log' });
    await harness.pool.query(
      `delete from role_permissions where role_id = $1 and object_type = 'audit_log' and action = 'read'`,
      [roleId],
    );

    await harness.drain();
    const job = await harness.archive(jobId);
    expect(job.status).toBe('failed');
  });
});

describe('what the archives contain', () => {
  it("a subject archive holds the person's record, activities, timeline, tags and history", async () => {
    const admin = await harness.user('Admin');
    const subject = await makeContact({ lastName: 'SubjectAccess' });

    const activityId = newId();
    const tagId = newId();
    await harness.pool.query(
      `insert into activities (id, tenant_id, type, subject, assigned_to)
       values ($1, $2, 'call', 'Discovery call', $3)`,
      [activityId, harness.tenantId, admin],
    );
    await harness.pool.query(
      `insert into activity_links (id, tenant_id, activity_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [newId(), harness.tenantId, activityId, subject],
    );
    await harness.pool.query(`insert into tags (id, tenant_id, name) values ($1, $2, $3)`, [
      tagId,
      harness.tenantId,
      `vip-${newId().slice(0, 6)}`,
    ]);
    await harness.pool.query(
      `insert into record_tags (id, tenant_id, tag_id, object_type, record_id)
       values ($1, $2, $3, 'contact', $4)`,
      [newId(), harness.tenantId, tagId, subject],
    );
    await harness.pool.query(
      `insert into timeline_events (id, tenant_id, object_type, record_id, event_type, summary)
       values ($1, $2, 'contact', $3, 'contact.created.v1', 'Contact created')`,
      [newId(), harness.tenantId, subject],
    );
    await writeAudit({ recordId: subject, changes: { lastName: { new: 'SubjectAccess' } } });

    const file = await produce({
      userId: owner,
      kind: 'data_subject',
      format: 'json',
      params: { subjectObjectType: 'contact', subjectRecordId: subject },
    });

    expect(file.status).toBe('completed');
    const parsed = JSON.parse(file.text) as {
      subject: {
        record: { last_name: string };
        activities: unknown[];
        timeline: unknown[];
        tags: unknown[];
        history: unknown[];
      };
    };
    expect(parsed.subject.record.last_name).toBe('SubjectAccess');
    expect(parsed.subject.activities).toHaveLength(1);
    expect(parsed.subject.timeline).toHaveLength(1);
    expect(parsed.subject.tags).toHaveLength(1);
    expect(parsed.subject.history.length).toBeGreaterThanOrEqual(1);
  });

  it('a whole-tenant archive is valid JSON with the configuration and the directory', async () => {
    await makeContact({ lastName: 'InTheArchive' });

    const file = await produce({ userId: owner, kind: 'tenant', format: 'json' });
    const parsed = JSON.parse(file.text) as {
      kind: string;
      tables: Record<string, unknown[]>;
      members: unknown[];
    };

    expect(parsed.kind).toBe('tenant');
    expect(parsed.tables['contacts']!.length).toBeGreaterThan(0);
    // Not only records: the metadata that makes them readable.
    expect(parsed.tables['field_definitions']!.length).toBeGreaterThan(0);
    expect(parsed.tables['roles']!.length).toBeGreaterThan(0);
    expect(parsed.members.length).toBeGreaterThan(0);
  });

  it('records the row count and audits the completion', async () => {
    const jobId = await harness.requestArchive({ userId: owner, kind: 'tenant' });
    await harness.drain();
    const job = await harness.archive(jobId);

    expect(job.status).toBe('completed');
    expect(job.rowCount ?? 0).toBeGreaterThan(0);
    expect(job.sizeBytes ?? 0).toBeGreaterThan(0);

    const audit = await harness.pool.query(
      `select changes from audit_logs where record_id = $1 and action = 'export'`,
      [jobId],
    );
    const completions = (audit.rows as { changes: Record<string, { new?: unknown }> | null }[]).map(
      (row) => row.changes?.['completed']?.new,
    );
    expect(completions).toContain(true);
  });

  it('is a no-op on redelivery rather than producing the file twice', async () => {
    const jobId = await harness.requestArchive({ userId: owner, kind: 'tenant' });
    await harness.drain();
    const first = await harness.archive(jobId);

    await harness.pool.query(
      `insert into outbox_events (id, tenant_id, event_type, object_type, record_id)
       values ($1, $2, 'data_export.requested.v1', 'data_export_job', $3)`,
      [newId(), harness.tenantId, jobId],
    );
    await harness.drain();

    const second = await harness.archive(jobId);
    expect(second.finishedAt?.getTime()).toBe(first.finishedAt?.getTime());
  });
});
