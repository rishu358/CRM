import { newId } from '@crm/core';
import { loadActor, loadFieldDefinitions, withTenant } from '@crm/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';
import { processChunk, type ChunkContext } from './import-rows.js';

/**
 * What an import can do that a normal write cannot (CLAUDE.md §5, §10).
 *
 * An import is the one path that creates and changes records in bulk from a
 * file a user supplies, so it is the path where a missing check is multiplied
 * by fifty thousand. These tests are the four mandatory suites — tenant
 * isolation, record scope, field permissions — plus the things that are
 * particular to imports: it must not set an owner, an id or a version; must not
 * write a field the actor cannot; and must not become a way to learn that a
 * colleague's record exists.
 */
let h: WorkerHarness;
let otherTenantId: string;
let owner: string;

const unique = (): string => newId().replaceAll('-', '').slice(-10);

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Import Security' });
  owner = await h.user('Owner');
  otherTenantId = (await h.fixtures.createTenant({ name: 'Import Security B' })).tenantId;
});

afterAll(async () => {
  await h.close();
});

const MAP = [
  { column: 0, field: 'last_name' },
  { column: 1, field: 'email' },
  { column: 2, field: 'title' },
];

async function importAs(
  userId: string,
  rows: (string | number)[][],
  options: {
    mapping?: { column: number; field: string }[];
    duplicateMode?: 'skip' | 'update' | 'create';
    matchField?: string | null;
  } = {},
) {
  const analyzed = await h.analyze({ userId, bytes: csv(rows) });
  expect(analyzed.status, analyzed.failureReason ?? '').toBe('awaiting_mapping');
  await h.start(analyzed.id, {
    mapping: options.mapping ?? MAP,
    duplicateMode: options.duplicateMode ?? 'create',
    matchField: options.matchField ?? null,
  });
  await h.drain();
  return h.job(analyzed.id);
}

async function contact(id: string): Promise<Record<string, unknown>> {
  const row = (await h.pool.query('select * from contacts where id = $1', [id])).rows[0];
  if (row === undefined) throw new Error(`No contact ${id}`);
  return row;
}

/** A role that can import at one scope, built the way an admin would build a custom role. */
async function importerRole(name: string, scope: 'own' | 'team' | 'all'): Promise<string> {
  const roleId = await h.fixtures.createRole(h.tenantId, `${name}-${unique()}`);
  for (const action of ['read', 'create', 'update', 'import'] as const) {
    await h.fixtures.grant(h.tenantId, roleId, 'contact', action, scope);
  }
  return roleId;
}

describe('(a) tenant isolation', () => {
  it('an import in tenant A never reads, matches or writes tenant B’s records', async () => {
    const tag = unique();
    const bContact = await h.fixtures.createContact(otherTenantId, {
      lastName: 'Theirs',
      email: `shared-${tag}@x.io`,
    });

    const job = await importAs(
      owner,
      [
        ['Last', 'Email', 'Title'],
        ['Ours', `shared-${tag}@x.io`, 'CEO'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );

    // B's record shares the email and is invisible: A's row is a *create*.
    expect(job).toMatchObject({ createdCount: 1, updatedCount: 0 });
    const theirs = await contact(bContact);
    expect(theirs).toMatchObject({ last_name: 'Theirs', title: null, version: 1 });

    const mine = await h.pool.query(
      `select tenant_id from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `shared-${tag}@x.io`],
    );
    expect(mine.rows).toHaveLength(1);
  });

  it('another tenant cannot see an import job, its staged rows or its errors', async () => {
    const tag = unique();
    const job = await importAs(owner, [
      ['Last', 'Email', 'Title'],
      ['Visible', `iso-${tag}@x.io`, 'x'],
      ['Bad', 'not-an-email', 'x'],
    ]);
    expect(job.failedCount).toBe(1);

    for (const table of ['import_jobs', 'import_rows', 'import_errors', 'export_jobs']) {
      const rows = await withTenant(h.db.db, { tenantId: otherTenantId, userId: null }, (tx) =>
        tx.execute(`select count(*)::int as n from ${table}` as never),
      );
      expect((rows.rows[0] as { n: number }).n).toBe(0);
    }
  });

  it('a job id from tenant A is no use inside tenant B (the row simply is not there)', async () => {
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        ['Last', 'Email', 'Title'],
        ['A', `x-${unique()}@x.io`, 'y'],
      ]),
    });
    const seen = await withTenant(h.db.db, { tenantId: otherTenantId, userId: null }, (tx) =>
      tx.execute(`select id from import_jobs where id = '${analyzed.id}'` as never),
    );
    expect(seen.rows).toHaveLength(0);
  });
});

describe('(b) record scope: an import only sees, matches and changes what its actor may', () => {
  it('an `own`-scope importer cannot match, update or learn of a colleague’s record', async () => {
    const tag = unique();
    const colleague = await h.user('Owner');
    const colleaguesContact = await h.fixtures.createContact(h.tenantId, {
      ownerId: colleague,
      lastName: 'Colleague',
      email: `colleague-${tag}@x.io`,
    });
    const roleId = await importerRole('own-importer', 'own');
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const job = await importAs(
      rep,
      [
        ['Last', 'Email', 'Title'],
        ['Hijack', `colleague-${tag}@x.io`, 'CEO'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );

    // Not matched, not updated, and — the part that matters — not reported: the
    // row is a plain create, with no error that says "that email exists".
    expect(job).toMatchObject({
      status: 'completed',
      createdCount: 1,
      updatedCount: 0,
      failedCount: 0,
    });
    expect(job.errorFileKey).toBeNull();
    expect(await contact(colleaguesContact)).toMatchObject({
      last_name: 'Colleague',
      title: null,
      version: 1,
      owner_id: colleague,
    });

    // The new record belongs to the importer.
    const created = await h.pool.query(
      `select owner_id from contacts where tenant_id = $1 and email::text = $2 and id <> $3`,
      [h.tenantId, `colleague-${tag}@x.io`, colleaguesContact],
    );
    expect(created.rows[0]?.['owner_id']).toBe(rep);
  });

  it('an `own`-scope importer can still update their own record', async () => {
    const tag = unique();
    const roleId = await importerRole('own-importer2', 'own');
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    const mine = await h.fixtures.createContact(h.tenantId, {
      ownerId: rep,
      lastName: 'Mine',
      email: `mine-${tag}@x.io`,
    });
    const job = await importAs(
      rep,
      [
        ['Last', 'Email', 'Title'],
        ['Mine', `mine-${tag}@x.io`, 'CTO'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );
    expect(job).toMatchObject({ updatedCount: 1, createdCount: 0 });
    expect(await contact(mine)).toMatchObject({ title: 'CTO', version: 2 });
  });

  it('a `team`-scope importer sees a teammate’s record but not an outsider’s', async () => {
    const tag = unique();
    const roleId = await importerRole('team-importer', 'team');
    const lead = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    const teammate = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    const outsider = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    await h.fixtures.createTeam(h.tenantId, `team-${tag}`, [lead, teammate]);

    const teammates = await h.fixtures.createContact(h.tenantId, {
      ownerId: teammate,
      lastName: 'Teammate',
      email: `tm-${tag}@x.io`,
    });
    const outsiders = await h.fixtures.createContact(h.tenantId, {
      ownerId: outsider,
      lastName: 'Outsider',
      email: `out-${tag}@x.io`,
    });

    // `skip` shows what the importer can *see*: the teammate's record is a
    // duplicate to them, the outsider's is not (it is created, not skipped).
    const job = await importAs(
      lead,
      [
        ['Last', 'Email', 'Title'],
        ['Teammate', `tm-${tag}@x.io`, 'VP'],
        ['Outsider', `out-${tag}@x.io`, 'VP'],
      ],
      { duplicateMode: 'skip', matchField: 'email' },
    );
    expect(job).toMatchObject({ skippedCount: 1, createdCount: 1 });
    expect(await contact(teammates)).toMatchObject({ title: null, version: 1 });
    expect(await contact(outsiders)).toMatchObject({ title: null, version: 1 });

    // `update` then applies the rule the API itself applies to a single record:
    // `can(actor, 'update', { record: { ownerId } })`, which resolves team scope
    // through `record.teamId` — and no service supplies one. So a team-scope user
    // can see a teammate's record and cannot edit it, in the API and here alike.
    // The import is deliberately *not* more permissive than the API; if the
    // platform gains team-aware record checks, this test is where it shows.
    const update = await importAs(
      lead,
      [
        ['Last', 'Email', 'Title'],
        ['Teammate', `tm-${tag}@x.io`, 'VP'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );
    expect(update).toMatchObject({ failedCount: 1, updatedCount: 0 });
    expect(await contact(teammates)).toMatchObject({ title: null, version: 1 });
  });

  it('refuses to update a record the importer can see but may not edit', async () => {
    const tag = unique();
    // Reads everything, updates only their own.
    const roleId = await h.fixtures.createRole(h.tenantId, `read-all-update-own-${unique()}`);
    await h.fixtures.grant(h.tenantId, roleId, 'contact', 'read', 'all');
    await h.fixtures.grant(h.tenantId, roleId, 'contact', 'create', 'all');
    await h.fixtures.grant(h.tenantId, roleId, 'contact', 'update', 'own');
    await h.fixtures.grant(h.tenantId, roleId, 'contact', 'import', 'all');
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const others = await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'NotYours',
      email: `ro-${tag}@x.io`,
    });
    const job = await importAs(
      rep,
      [
        ['Last', 'Email', 'Title'],
        ['NotYours', `ro-${tag}@x.io`, 'CEO'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );
    expect(job).toMatchObject({ failedCount: 1, updatedCount: 0 });
    expect(await contact(others)).toMatchObject({ title: null, version: 1 });
  });
});

describe('what a file can never set', () => {
  it('cannot assign ownership: every record is owned by the importer', async () => {
    const tag = unique();
    const victim = await h.user('Owner');
    const job = await importAs(
      owner,
      [
        ['Last', 'Email', 'Owner'],
        ['A', `own-${tag}@x.io`, victim],
      ],
      {
        // The mapping check refuses it up front...
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
        ],
      },
    );
    expect(job.status).toBe('completed');
    const created = await h.pool.query(
      `select owner_id from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `own-${tag}@x.io`],
    );
    expect(created.rows[0]?.['owner_id']).toBe(owner);
    expect(created.rows[0]?.['owner_id']).not.toBe(victim);
  });

  it('refuses a mapping onto owner_id at start, and stops if one reaches the worker anyway', async () => {
    const tag = unique();
    const victim = await h.user('Owner');
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        ['Last', 'Email', 'Owner'],
        ['A', `own2-${tag}@x.io`, victim],
      ]),
    });
    // Skip the API's validation entirely and hand the worker a hostile mapping.
    await h.start(analyzed.id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'email' },
        { column: 2, field: 'owner_id' },
      ],
    });
    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('failed');
    const created = await h.pool.query(
      `select count(*)::int as n from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `own2-${tag}@x.io`],
    );
    expect(created.rows[0]?.['n']).toBe(0);
  });

  it('the row-level guard refuses owner_id even when the mapping check is bypassed (update path)', async () => {
    // Call the writer directly with a mapping containing owner_id, which no
    // earlier check is given the chance to refuse. An update patch built from
    // it would reassign a record; the per-row guard must stop it.
    const tag = unique();
    const victim = await h.user('Owner');
    const existing = await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'Keep',
      email: `guard-${tag}@x.io`,
    });

    const result = await withTenant(
      h.db.db,
      { tenantId: h.tenantId, userId: owner },
      async (tx) => {
        const actor = (await loadActor(tx, owner, h.tenantId))!;
        const fields = await loadFieldDefinitions(tx, h.tenantId, 'contact');
        const context: ChunkContext = {
          actor,
          jobId: newId(),
          objectType: 'contact',
          fields,
          mapping: [
            { column: 0, field: 'email' },
            { column: 1, field: 'owner_id' },
          ],
          duplicateMode: 'update',
          matchField: 'email',
        };
        return processChunk(tx, context, [
          { rowNumber: 1, sourceRow: 2, cells: [`guard-${tag}@x.io`, victim] },
        ]);
      },
    );

    expect(result).toMatchObject({ failed: 1, updated: 0, created: 0 });
    expect(result.errors[0]?.message).toMatch(/cannot be set by an import/);
    expect(await contact(existing)).toMatchObject({ owner_id: owner, version: 1 });
  });

  it('cannot create a converted lead: conversion is a transaction of its own', async () => {
    const tag = unique();
    const jobId = await h.upload({
      userId: owner,
      objectType: 'lead',
      bytes: csv([
        ['Last', 'Email', 'Status'],
        ['Fine', `lead-ok-${tag}@x.io`, 'qualified'],
        ['Sneaky', `lead-conv-${tag}@x.io`, 'converted'],
      ]),
    });
    await h.confirmUpload(jobId);
    await h.drain();
    await h.start(jobId, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'email' },
        { column: 2, field: 'status' },
      ],
    });
    await h.drain();

    const job = await h.job(jobId);
    expect(job).toMatchObject({ createdCount: 1, failedCount: 1 });
    const leads = await h.pool.query(
      `select email::text as email, status, converted_at from leads
       where tenant_id = $1 and email::text like $2`,
      [h.tenantId, `%-${tag}@x.io`],
    );
    expect(leads.rows).toEqual([
      { email: `lead-ok-${tag}@x.io`, status: 'qualified', converted_at: null },
    ]);
  });

  it('cannot smuggle a column the metadata does not describe', async () => {
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        ['Last', 'Email', 'X'],
        ['A', `smuggle-${unique()}@x.io`, '1'],
      ]),
    });
    for (const field of ['version', 'tenant_id', 'id', 'created_by', 'deleted_at']) {
      const job = await h.analyze({
        userId: owner,
        bytes: csv([
          ['Last', 'Email', 'X'],
          ['A', `smuggle-${unique()}@x.io`, '1'],
        ]),
      });
      await h.start(job.id, {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: field },
        ],
      });
      await h.drain();
      expect((await h.job(job.id)).status, field).toBe('failed');
    }
    void analyzed;
  });
});

describe('(c) field-level permissions are honoured per row', () => {
  it('stops the import if a mapped field stops being writable mid-run', async () => {
    const tag = unique();
    const roleId = await importerRole('field-revoked', 'all');
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const analyzed = await h.analyze({
      userId: rep,
      bytes: csv([
        ['Last', 'Email', 'Title'],
        ['A', `fp-${tag}@x.io`, 'CEO'],
      ]),
    });
    await h.start(analyzed.id, { mapping: MAP });
    await h.relay.tick(); // staged

    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'title', 'read');
    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('failed');
    const created = await h.pool.query(
      `select count(*)::int as n from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `fp-${tag}@x.io`],
    );
    expect(created.rows[0]?.['n']).toBe(0);
  });

  it('the row-level guard refuses an unwritable field even when the mapping check is bypassed', async () => {
    const tag = unique();
    const roleId = await importerRole('field-guard', 'all');
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'title', 'read');
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'phone', 'hidden');
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const result = await withTenant(h.db.db, { tenantId: h.tenantId, userId: rep }, async (tx) => {
      const actor = (await loadActor(tx, rep, h.tenantId))!;
      const fields = await loadFieldDefinitions(tx, h.tenantId, 'contact');
      return processChunk(
        tx,
        {
          actor,
          jobId: newId(),
          objectType: 'contact',
          fields,
          mapping: [
            { column: 0, field: 'last_name' },
            { column: 1, field: 'email' },
            { column: 2, field: 'title' },
            { column: 3, field: 'phone' },
          ],
          duplicateMode: 'create',
          matchField: null,
        },
        [
          { rowNumber: 1, sourceRow: 2, cells: ['A', `fg-${tag}@x.io`, 'CEO', '+919876543210'] },
          { rowNumber: 2, sourceRow: 3, cells: ['B', `fg2-${tag}@x.io`, '', ''] },
        ],
      );
    });

    // Row 1 tried to write a read-only and a hidden field: refused, and — the
    // important half — not created at all, rather than created without them.
    // Row 2 supplied neither and is fine.
    expect(result).toMatchObject({ failed: 1, created: 1 });
    const messages = result.errors.map((error) => error.message).join('|');
    expect(messages).toContain('you do not have permission to write this field');
    const rows = await h.pool.query(
      `select email::text as email, title, phone from contacts where tenant_id = $1 and email::text like $2`,
      [h.tenantId, `%-${tag}@x.io`],
    );
    expect(rows.rows).toEqual([{ email: `fg2-${tag}@x.io`, title: null, phone: null }]);
  });
});

describe('audit and events', () => {
  it('every record carries an audit entry naming the import that made it', async () => {
    const tag = unique();
    const job = await importAs(owner, [
      ['Last', 'Email', 'Title'],
      ['Audited', `audit-${tag}@x.io`, 'x'],
    ]);
    const created = await h.pool.query(
      `select id from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `audit-${tag}@x.io`],
    );
    const audit = await h.pool.query(
      `select actor_id, changes from audit_logs
       where tenant_id = $1 and action = 'create' and record_id = $2`,
      [h.tenantId, created.rows[0]?.['id']],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.['actor_id']).toBe(owner);
    expect((audit.rows[0]?.['changes'] as Record<string, unknown>)['importJobId']).toEqual({
      new: job.id,
    });
  });

  it('the import-job audit trail records start and completion with the counts', async () => {
    const job = await importAs(owner, [
      ['Last', 'Email', 'Title'],
      ['Counted', `counted-${unique()}@x.io`, 'x'],
    ]);
    const entries = await h.pool.query(
      `select changes from audit_logs
       where tenant_id = $1 and action = 'import' and record_id = $2 and actor_id = $3`,
      [h.tenantId, job.id, owner],
    );
    const completed = entries.rows.find(
      (row) =>
        (row['changes'] as { status?: { new?: unknown } } | null)?.status?.new === 'completed',
    );
    expect(completed?.['changes']).toMatchObject({ created: { new: 1 }, failed: { new: 0 } });
  });
});
