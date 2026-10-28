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

async function emailOf(userId: string): Promise<string> {
  return h.fixtures.emailFor(userId);
}

/** Someone who can import contacts and read accounts, but only their own. */
async function ownScopeRep(): Promise<string> {
  const roleId = await h.fixtures.createRole(h.tenantId, `own-rep-${unique()}`);
  for (const action of ['read', 'create', 'update', 'import'] as const) {
    await h.fixtures.grant(h.tenantId, roleId, 'contact', action, 'own');
  }
  await h.fixtures.grant(h.tenantId, roleId, 'account', 'read', 'own');
  return (await h.fixtures.createUser(h.tenantId, roleId)).userId;
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

  it('a `team`-scope importer sees and edits a teammate’s record, never an outsider’s', async () => {
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

    // `update` applies the rule the API itself applies to a single record:
    // `can(actor, 'update', { record })`. Team scope means "owned by anyone in
    // my teams", so a teammate's record **is** editable here — as it is through
    // the API, once the services supply the owner's teams (ADR-0033). The
    // outsider's record, owned by someone in no shared team, is neither seen
    // (above) nor touched (below).
    const update = await importAs(
      lead,
      [
        ['Last', 'Email', 'Title'],
        ['Teammate', `tm-${tag}@x.io`, 'VP'],
      ],
      { duplicateMode: 'update', matchField: 'email' },
    );
    expect(update).toMatchObject({ updatedCount: 1, failedCount: 0 });
    expect(await contact(teammates)).toMatchObject({ title: 'VP', version: 2 });
    expect(await contact(outsiders)).toMatchObject({ title: null, version: 1 });
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

  it('refuses a mapping onto owner_id from an `own`-scope importer, and stops if one reaches the worker anyway', async () => {
    const tag = unique();
    const victim = await h.user('Owner');
    const rep = await ownScopeRep();
    const analyzed = await h.analyze({
      userId: rep,
      bytes: csv([
        ['Last', 'Email', 'Owner'],
        ['A', `own2-${tag}@x.io`, await emailOf(victim)],
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

  it('the row-level guard refuses an owner for an `own`-scope importer even when the mapping check is bypassed (update path)', async () => {
    // Call the writer directly with a mapping containing owner_id, which no
    // earlier check is given the chance to refuse. An update patch built from
    // it would reassign a record; the per-row guard must stop it.
    const tag = unique();
    const victim = await h.user('Owner');
    const rep = await ownScopeRep();
    const existing = await h.fixtures.createContact(h.tenantId, {
      ownerId: rep,
      lastName: 'Keep',
      email: `guard-${tag}@x.io`,
    });

    const result = await withTenant(h.db.db, { tenantId: h.tenantId, userId: rep }, async (tx) => {
      const actor = (await loadActor(tx, rep, h.tenantId))!;
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
        { rowNumber: 1, sourceRow: 2, cells: [`guard-${tag}@x.io`, await emailOf(victim)] },
      ]);
    });

    expect(result).toMatchObject({ failed: 1, updated: 0, created: 0 });
    expect(result.errors[0]?.message).toMatch(/cannot assign records to another user/);
    expect(await contact(existing)).toMatchObject({ owner_id: rep, version: 1 });
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

describe('owner and account columns (ADR-0067)', () => {
  const LINKED = [
    { column: 0, field: 'last_name' },
    { column: 1, field: 'email' },
    { column: 2, field: 'owner_id' },
    { column: 3, field: 'account_id' },
  ];
  const HEAD = ['Last', 'Email', 'Owner', 'Account'];

  const ownerOf = async (email: string): Promise<unknown> =>
    (
      await h.pool.query(
        `select owner_id, account_id from contacts where tenant_id = $1 and email::text = $2`,
        [h.tenantId, email],
      )
    ).rows[0];

  const errorsOf = async (jobId: string) =>
    (
      await h.pool.query(
        `select field, message from import_errors where job_id = $1 order by row_number`,
        [jobId],
      )
    ).rows;

  it('gives each row the owner and account its cells name, by e-mail, name, domain or id', async () => {
    const tag = unique();
    const member = await h.user('Sales Rep');
    const named = await h.fixtures.createAccount(h.tenantId, {
      name: `Named ${tag}`,
      ownerId: owner,
    });
    const byDomain = await h.fixtures.createAccount(h.tenantId, {
      name: `Dom ${tag}`,
      domain: `dom-${tag}.example`,
      ownerId: owner,
    });
    const byId = await h.fixtures.createAccount(h.tenantId, {
      name: `Ident ${tag}`,
      ownerId: owner,
    });

    const job = await importAs(
      owner,
      [
        HEAD,
        ['A', `a-${tag}@x.io`, (await emailOf(member)).toUpperCase(), `Named ${tag}`],
        ['B', `b-${tag}@x.io`, await emailOf(member), `DOM-${tag}.example`],
        ['C', `c-${tag}@x.io`, '', byId],
      ],
      { mapping: LINKED },
    );

    expect(job).toMatchObject({ status: 'completed', createdCount: 3, failedCount: 0 });
    expect(await ownerOf(`a-${tag}@x.io`)).toMatchObject({ owner_id: member, account_id: named });
    expect(await ownerOf(`b-${tag}@x.io`)).toMatchObject({
      owner_id: member,
      account_id: byDomain,
    });
    // A blank owner cell means the importer owns the row.
    expect(await ownerOf(`c-${tag}@x.io`)).toMatchObject({ owner_id: owner, account_id: byId });

    // The audit entry carries both, next to the job that made it.
    const created = await h.pool.query(
      `select id from contacts where tenant_id = $1 and email::text = $2`,
      [h.tenantId, `a-${tag}@x.io`],
    );
    const audit = await h.pool.query(
      `select changes from audit_logs where tenant_id = $1 and action = 'create' and record_id = $2`,
      [h.tenantId, created.rows[0]?.['id']],
    );
    const changes = audit.rows[0]?.['changes'] as Record<string, { new?: unknown }>;
    expect(changes['ownerId']?.new).toBe(member);
    expect(changes['accountId']?.new).toBe(named);
  });

  it('fails only the row whose owner or account is wrong, and says which cell', async () => {
    const tag = unique();
    const job = await importAs(
      owner,
      [
        HEAD,
        ['Good', `good-${tag}@x.io`, '', ''],
        ['NoOwner', `noowner-${tag}@x.io`, `nobody-${tag}@x.io`, ''],
        ['NoAccount', `noacct-${tag}@x.io`, '', `No such company ${tag}`],
      ],
      { mapping: LINKED },
    );

    expect(job).toMatchObject({ createdCount: 1, failedCount: 2 });
    expect(await ownerOf(`noowner-${tag}@x.io`)).toBeUndefined();
    expect(await ownerOf(`noacct-${tag}@x.io`)).toBeUndefined();
    expect(await errorsOf(job.id)).toEqual([
      { field: 'owner_id', message: 'Owner: unknown member' },
      { field: 'account_id', message: `Account: no account matches "No such company ${tag}"` },
    ]);
  });

  it('never guesses: two accounts with one name is an error, not the first one', async () => {
    const tag = unique();
    await h.fixtures.createAccount(h.tenantId, { name: `Twin ${tag}`, ownerId: owner });
    await h.fixtures.createAccount(h.tenantId, { name: `Twin ${tag}`, ownerId: owner });
    const job = await importAs(owner, [HEAD, ['T', `t-${tag}@x.io`, '', `Twin ${tag}`]], {
      mapping: LINKED,
    });
    expect(job).toMatchObject({ createdCount: 0, failedCount: 1 });
    expect((await errorsOf(job.id))[0]?.['message']).toMatch(/matches 2 accounts/);
  });

  it('does not find an account in another workspace, by name, domain or id', async () => {
    const tag = unique();
    const theirs = await h.fixtures.createAccount(otherTenantId, {
      name: `Theirs ${tag}`,
      domain: `theirs-${tag}.example`,
    });
    const job = await importAs(
      owner,
      [
        HEAD,
        ['N', `n-${tag}@x.io`, '', `Theirs ${tag}`],
        ['D', `d-${tag}@x.io`, '', `theirs-${tag}.example`],
        ['I', `i-${tag}@x.io`, '', theirs],
      ],
      { mapping: LINKED },
    );
    expect(job).toMatchObject({ createdCount: 0, failedCount: 3 });
  });

  it('an `own`-scope importer finds only their own accounts, and a colleague’s answers as one that does not exist', async () => {
    const tag = unique();
    const rep = await ownScopeRep();
    await h.fixtures.createAccount(h.tenantId, { name: `Colleague Co ${tag}`, ownerId: owner });
    const mine = await h.fixtures.createAccount(h.tenantId, { name: `Mine ${tag}`, ownerId: rep });

    // The account column is on offer to them; the owner column is not.
    const job = await importAs(
      rep,
      [
        ['Last', 'Email', 'Account'],
        ['M', `m-${tag}@x.io`, `Mine ${tag}`],
        ['C', `c-${tag}@x.io`, `Colleague Co ${tag}`],
        ['G', `g-${tag}@x.io`, `Ghost Co ${tag}`],
      ],
      {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: 'account_id' },
        ],
      },
    );
    expect(job).toMatchObject({ createdCount: 1, failedCount: 2 });
    expect(await ownerOf(`m-${tag}@x.io`)).toMatchObject({ owner_id: rep, account_id: mine });
    expect((await errorsOf(job.id)).map((row) => row['message'])).toEqual([
      `Account: no account matches "Colleague Co ${tag}"`,
      `Account: no account matches "Ghost Co ${tag}"`,
    ]);
  });

  it('a `team`-scope importer may hand rows to a teammate, and to nobody outside the team', async () => {
    const tag = unique();
    const roleId = await importerRole('team-assigner', 'team');
    await h.fixtures.grant(h.tenantId, roleId, 'account', 'read', 'all');
    const lead = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    const teammate = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    const outsider = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    await h.fixtures.createTeam(h.tenantId, `assign-${tag}`, [lead, teammate]);

    const job = await importAs(
      lead,
      [
        HEAD,
        ['T', `tm-${tag}@x.io`, await emailOf(teammate), ''],
        ['S', `self-${tag}@x.io`, await emailOf(lead), ''],
        ['O', `out-${tag}@x.io`, await emailOf(outsider), ''],
        ['U', `unk-${tag}@x.io`, `nobody-${tag}@x.io`, ''],
      ],
      { mapping: LINKED },
    );

    expect(job).toMatchObject({ createdCount: 2, failedCount: 2 });
    expect(await ownerOf(`tm-${tag}@x.io`)).toMatchObject({ owner_id: teammate });
    expect(await ownerOf(`self-${tag}@x.io`)).toMatchObject({ owner_id: lead });
    // Somebody outside the team answers exactly as somebody who is not a member at all.
    expect((await errorsOf(job.id)).map((row) => row['message'])).toEqual([
      'Owner: unknown member',
      'Owner: unknown member',
    ]);
  });

  it('will not hand a row to someone who could not see it', async () => {
    const tag = unique();
    const blindRole = await h.fixtures.createRole(h.tenantId, `no-contacts-${unique()}`);
    const blind = (await h.fixtures.createUser(h.tenantId, blindRole)).userId;
    const job = await importAs(owner, [HEAD, ['B', `b-${tag}@x.io`, await emailOf(blind), '']], {
      mapping: LINKED,
    });
    expect(job).toMatchObject({ createdCount: 0, failedCount: 1 });
    expect((await errorsOf(job.id))[0]?.['message']).toMatch(/cannot see this kind of record/);
  });

  it('will not hand a row to a member whose membership is not active', async () => {
    const tag = unique();
    const suspended = await h.user('Sales Rep');
    await h.fixtures.setMembershipStatus(h.tenantId, suspended, 'suspended');
    const job = await importAs(
      owner,
      [HEAD, ['S', `s-${tag}@x.io`, await emailOf(suspended), '']],
      {
        mapping: LINKED,
      },
    );
    expect(job).toMatchObject({ createdCount: 0, failedCount: 1 });
  });

  it('on an update, sets the account and owner, and leaves an existing link alone when the cell is blank', async () => {
    const tag = unique();
    const member = await h.user('Sales Rep');
    const firstAccount = await h.fixtures.createAccount(h.tenantId, { name: `First ${tag}` });
    const secondAccount = await h.fixtures.createAccount(h.tenantId, { name: `Second ${tag}` });
    const existing = await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      accountId: firstAccount,
      lastName: 'Link',
      email: `link-${tag}@x.io`,
    });

    const keep = await importAs(owner, [HEAD, ['Link', `link-${tag}@x.io`, '', '']], {
      mapping: LINKED,
      duplicateMode: 'update',
      matchField: 'email',
    });
    expect(keep).toMatchObject({ updatedCount: 0, skippedCount: 1 });
    expect(await contact(existing)).toMatchObject({ account_id: firstAccount, owner_id: owner });

    const move = await importAs(
      owner,
      [HEAD, ['Link', `link-${tag}@x.io`, await emailOf(member), `Second ${tag}`]],
      { mapping: LINKED, duplicateMode: 'update', matchField: 'email' },
    );
    expect(move).toMatchObject({ updatedCount: 1, failedCount: 0 });
    expect(await contact(existing)).toMatchObject({
      account_id: secondAccount,
      owner_id: member,
      version: 2,
    });
  });

  it('refuses an account link when a field rule hides it, even if the mapping check is bypassed', async () => {
    const tag = unique();
    const roleId = await importerRole('no-account-field', 'all');
    await h.fixtures.grant(h.tenantId, roleId, 'account', 'read', 'all');
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'account_id', 'hidden');
    const user = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    await h.fixtures.createAccount(h.tenantId, { name: `Hidden ${tag}` });

    const result = await withTenant(h.db.db, { tenantId: h.tenantId, userId: user }, async (tx) => {
      const actor = (await loadActor(tx, user, h.tenantId))!;
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
            { column: 1, field: 'account_id' },
          ],
          duplicateMode: 'create',
          matchField: null,
        },
        [{ rowNumber: 1, sourceRow: 2, cells: ['H', `Hidden ${tag}`] }],
      );
    });
    expect(result).toMatchObject({ created: 0, failed: 1 });
    expect(result.errors[0]?.message).toMatch(/permission to write this field/);
  });

  it('works for leads (owner) and refuses an account column on accounts', async () => {
    const tag = unique();
    const member = await h.user('Sales Rep');
    const leadJob = await h.analyze({
      userId: owner,
      objectType: 'lead',
      bytes: csv([
        ['Last', 'Owner'],
        [`L${tag}`, await emailOf(member)],
      ]),
    });
    await h.start(leadJob.id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'owner_id' },
      ],
    });
    await h.drain();
    expect((await h.job(leadJob.id)).createdCount).toBe(1);
    const lead = await h.pool.query(
      `select owner_id from leads where tenant_id = $1 and last_name = $2`,
      [h.tenantId, `L${tag}`],
    );
    expect(lead.rows[0]?.['owner_id']).toBe(member);

    const accountJob = await h.analyze({
      userId: owner,
      objectType: 'account',
      bytes: csv([
        ['Name', 'Account'],
        [`Acct ${tag}`, 'x'],
      ]),
    });
    await h.start(accountJob.id, {
      mapping: [
        { column: 0, field: 'name' },
        { column: 1, field: 'account_id' },
      ],
    });
    await h.drain();
    expect((await h.job(accountJob.id)).status).toBe('failed');
  });
});
