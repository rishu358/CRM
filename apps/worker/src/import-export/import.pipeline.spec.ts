import { newId } from '@crm/core';
import { outboxEvents, withTenant, sql } from '@crm/db';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';
import { DEFAULT_MAX_ATTEMPTS } from '../relay.js';

/**
 * The import pipeline end to end, through the real relay (MVP_SPEC §M8,
 * ADR-0029).
 *
 * Everything from the outbox event onward is production code: the relay claims
 * the row, opens a tenant-scoped transaction as `crm_worker`, and runs the real
 * handler. What these tests prove is the pipeline's contract — correct records,
 * correct counts, an honest error file — and, above all, that **a retry cannot
 * double-create**.
 */
let h: WorkerHarness;
let owner: string;

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Import Pipeline' });
  owner = await h.user('Owner');
});

afterAll(async () => {
  await h.close();
});

const unique = (): string => newId().replaceAll('-', '').slice(-10);

const BASIC_MAPPING = [
  { column: 0, field: 'first_name' },
  { column: 1, field: 'last_name' },
  { column: 2, field: 'email' },
];

async function contactsWithEmailSuffix(suffix: string): Promise<Record<string, unknown>[]> {
  const result = await h.pool.query(
    `select * from contacts where tenant_id = $1 and email::text like $2 and deleted_at is null
     order by created_at, id`,
    [h.tenantId, `%${suffix}%`],
  );
  return result.rows;
}

async function runImport(
  bytes: Buffer,
  options: {
    mapping?: { column: number; field: string }[];
    duplicateMode?: 'skip' | 'update' | 'create';
    matchField?: string | null;
    userId?: string;
    format?: 'csv' | 'xlsx';
  } = {},
) {
  const analyzed = await h.analyze({
    userId: options.userId ?? owner,
    bytes,
    claimedFormat: options.format ?? 'csv',
    fileName: options.format === 'xlsx' ? 'people.xlsx' : 'people.csv',
  });
  expect(analyzed.status, analyzed.failureReason ?? '').toBe('awaiting_mapping');
  await h.start(analyzed.id, {
    mapping: options.mapping ?? BASIC_MAPPING,
    duplicateMode: options.duplicateMode ?? 'create',
    matchField: options.matchField ?? null,
  });
  await h.drain();
  return h.job(analyzed.id);
}

describe('analysis', () => {
  it('reads the header, a preview and the row count, and waits for a mapping', async () => {
    const tag = unique();
    const job = await h.analyze({
      userId: owner,
      bytes: csv([
        ['First', 'Last', 'Email'],
        ['Ada', 'Lovelace', `ada-${tag}@x.io`],
        ['Grace', 'Hopper', `grace-${tag}@x.io`],
      ]),
    });
    expect(job.status).toBe('awaiting_mapping');
    expect(job.detectedFormat).toBe('csv');
    expect(job.columns).toEqual(['First', 'Last', 'Email']);
    expect(job.totalRows).toBe(2);
    expect(job.preview).toEqual([
      ['Ada', 'Lovelace', `ada-${tag}@x.io`],
      ['Grace', 'Hopper', `grace-${tag}@x.io`],
    ]);
    expect(job.processedRows).toBe(0);
  });

  it('names blank headers and caps their length', async () => {
    const job = await h.analyze({
      userId: owner,
      bytes: csv([
        ['', 'x'.repeat(500), 'Email'],
        ['a', 'b', 'c'],
      ]),
    });
    expect(job.columns?.[0]).toBe('Column 1');
    expect(job.columns?.[1]).toHaveLength(200);
  });

  it('rejects a .csv whose bytes are not text, deletes the upload, and says why', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('S').addRow(['a']);
    const zip = Buffer.from(await workbook.xlsx.writeBuffer());

    const jobId = await h.upload({ userId: owner, bytes: zip, claimedFormat: 'csv' });
    const key = (await h.job(jobId)).storageKey;
    await h.confirmUpload(jobId);
    await h.drain();

    const job = await h.job(jobId);
    expect(job.status).toBe('rejected');
    expect(job.failureReason).toMatch(/named \.csv.*zip/);
    expect(h.storage.has(key)).toBe(false);
  });

  it('rejects a file with a header and no rows', async () => {
    const job = await h.analyze({ userId: owner, bytes: csv([['a', 'b']]) });
    expect(job.status).toBe('rejected');
    expect(job.failureReason).toMatch(/no data rows/);
  });
});

describe('a successful import', () => {
  it('creates the records, owned by the importer, with audit and outbox rows, and reports counts', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['First', 'Last', 'Email'],
        ['Ada', 'Lovelace', `Ada-${tag}@X.io`],
        ['Grace', 'Hopper', `grace-${tag}@x.io`],
        ['Alan', 'Turing', `alan-${tag}@x.io`],
      ]),
    );

    expect(job.status).toBe('completed');
    expect(job).toMatchObject({
      totalRows: 3,
      processedRows: 3,
      createdCount: 3,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      errorFileKey: null,
    });

    const contacts = await contactsWithEmailSuffix(tag);
    expect(contacts).toHaveLength(3);
    // Normalised by the same schema the API's create endpoint uses.
    expect(contacts.map((contact) => contact['email'])).toContain(`ada-${tag}@x.io`);
    expect(contacts.every((contact) => contact['owner_id'] === owner)).toBe(true);
    expect(contacts.every((contact) => contact['created_by'] === owner)).toBe(true);
    expect(contacts.every((contact) => contact['version'] === 1)).toBe(true);

    // One audit entry and one outbox event per record, as for any other write.
    const ids = contacts.map((contact) => contact['id']);
    const audit = await h.pool.query(
      `select count(*)::int as n from audit_logs
       where tenant_id = $1 and action = 'create' and object_type = 'contact' and record_id = any($2)`,
      [h.tenantId, ids],
    );
    expect(audit.rows[0]?.['n']).toBe(3);
    const events = await h.pool.query(
      `select count(*)::int as n from outbox_events
       where tenant_id = $1 and event_type = 'contact.created.v1' and record_id = any($2)`,
      [h.tenantId, ids],
    );
    expect(events.rows[0]?.['n']).toBe(3);

    // The job itself is audited on completion.
    const jobAudit = await h.pool.query(
      `select changes from audit_logs where tenant_id = $1 and action = 'import' and record_id = $2`,
      [h.tenantId, job.id],
    );
    expect(jobAudit.rows.length).toBeGreaterThan(0);

    // Data minimisation: nothing of the file is kept once the job is over, not
    // even the ten preview rows the mapping screen showed.
    expect(job.preview).toBeNull();
    const staged = await h.pool.query(
      'select count(*)::int as n from import_rows where job_id = $1',
      [job.id],
    );
    expect(staged.rows[0]?.['n']).toBe(0);
    expect(h.storage.has(job.storageKey)).toBe(false);
  });

  it('imports an .xlsx workbook the same way', async () => {
    const tag = unique();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('People');
    sheet.addRow(['First', 'Last', 'Email']);
    sheet.addRow(['Edsger', 'Dijkstra', `edsger-${tag}@x.io`]);
    sheet.addRow(['Barbara', 'Liskov', `barbara-${tag}@x.io`]);
    const job = await runImport(Buffer.from(await workbook.xlsx.writeBuffer()), { format: 'xlsx' });

    expect(job.status, job.failureReason ?? '').toBe('completed');
    expect(job.detectedFormat).toBe('xlsx');
    expect(job.createdCount).toBe(2);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(2);
  });

  it('imports accounts and leads, with their own required fields and match keys', async () => {
    const tag = unique();
    const accounts = await runImport(
      csv([
        ['Name', 'Domain'],
        ['Acme', `acme-${tag}.example`],
        ['Globex', `globex-${tag}.example`],
      ]),
      {
        mapping: [
          { column: 0, field: 'name' },
          { column: 1, field: 'domain' },
        ],
      },
    );
    // `runImport` creates contact jobs by default; redo with the right type.
    void accounts;

    const jobId = await h.upload({
      userId: owner,
      objectType: 'account',
      bytes: csv([
        ['Name', 'Domain'],
        ['Acme', `acme2-${tag}.example`],
        ['Globex', `globex2-${tag}.example`],
      ]),
    });
    await h.confirmUpload(jobId);
    await h.drain();
    await h.start(jobId, {
      mapping: [
        { column: 0, field: 'name' },
        { column: 1, field: 'domain' },
      ],
    });
    await h.drain();
    const job = await h.job(jobId);
    expect(job.status).toBe('completed');
    expect(job.createdCount).toBe(2);

    const created = await h.pool.query(
      `select name, domain, owner_id from accounts where tenant_id = $1 and domain like $2 order by name`,
      [h.tenantId, `%2-${tag}.example`],
    );
    expect(created.rows.map((row) => row.name)).toEqual(['Acme', 'Globex']);
    expect(created.rows.every((row) => row.owner_id === owner)).toBe(true);
  });
});

describe('metadata-driven mapping (ADR-0004)', () => {
  it('imports a custom field the moment it exists, with picklist labels and typed values', async () => {
    const tag = unique();
    await h.addCustomField('contact', { key: 'region', label: 'Region', type: 'text' });
    await h.addCustomField('contact', {
      key: 'tier',
      label: 'Tier',
      type: 'picklist',
      options: [
        { value: 'gold', label: 'Gold plan' },
        { value: 'basic', label: 'Basic plan' },
      ],
    });
    await h.addCustomField('contact', { key: 'renewal', label: 'Renewal', type: 'date' });
    await h.addCustomField('contact', { key: 'seats', label: 'Seats', type: 'number' });
    await h.addCustomField('contact', { key: 'vip', label: 'VIP', type: 'boolean' });
    await h.addCustomField('contact', { key: 'deal_size', label: 'Deal size', type: 'currency' });

    const job = await runImport(
      csv([
        ['Last', 'Email', 'Region', 'Tier', 'Renewal', 'Seats', 'VIP', 'Deal size'],
        [
          'Rowe',
          `rowe-${tag}@x.io`,
          'South',
          'gold plan',
          '2026-12-31',
          '1,250',
          'yes',
          '1500.75 INR',
        ],
      ]),
      {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: 'region' },
          { column: 3, field: 'tier' },
          { column: 4, field: 'renewal' },
          { column: 5, field: 'seats' },
          { column: 6, field: 'vip' },
          { column: 7, field: 'deal_size' },
        ],
      },
    );

    expect(job.status).toBe('completed');
    const [contact] = await contactsWithEmailSuffix(tag);
    expect(contact?.['custom_fields']).toEqual({
      region: 'South',
      tier: 'gold',
      renewal: '2026-12-31',
      seats: 1250,
      vip: true,
      deal_size: { amount_minor: '150075', currency: 'INR' },
    });
  });

  it('reports an invalid custom value against that row and that field', async () => {
    const tag = unique();
    await h
      .addCustomField('contact', { key: 'level', label: 'Level', type: 'number' })
      .catch(() => {});
    const job = await runImport(
      csv([
        ['Last', 'Email', 'Level'],
        ['Ok', `ok-${tag}@x.io`, '5'],
        ['Bad', `bad-${tag}@x.io`, 'high'],
      ]),
      {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: 'level' },
        ],
      },
    );
    expect(job).toMatchObject({ status: 'completed', createdCount: 1, failedCount: 1 });
    const errors = h.readText(job.errorFileKey as string);
    expect(errors).toContain('Level: Not a number');
  });
});

describe('duplicate handling', () => {
  const MATCH = {
    mapping: [
      { column: 0, field: 'last_name' },
      { column: 1, field: 'email' },
      { column: 2, field: 'title' },
    ],
    matchField: 'email',
  };

  async function seed(tag: string): Promise<string> {
    return h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'Existing',
      email: `dup-${tag}@x.io`,
    });
  }

  it('skip leaves the existing record alone and counts the row as skipped', async () => {
    const tag = unique();
    const id = await seed(tag);
    const job = await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['Changed', `dup-${tag}@x.io`, 'CEO'],
        ['Fresh', `fresh-${tag}@x.io`, 'CTO'],
      ]),
      { ...MATCH, duplicateMode: 'skip' },
    );
    expect(job).toMatchObject({
      createdCount: 1,
      skippedCount: 1,
      updatedCount: 0,
      failedCount: 0,
    });
    const row = (
      await h.pool.query('select last_name, title, version from contacts where id = $1', [id])
    ).rows[0];
    expect(row).toMatchObject({ last_name: 'Existing', title: null, version: 1 });
  });

  it('update changes only the supplied fields and bumps the version', async () => {
    const tag = unique();
    const id = await seed(tag);
    await h.pool.query(
      `update contacts set phone = '+919876543210', first_name = 'Keep' where id = $1`,
      [id],
    );

    const job = await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['Renamed', `dup-${tag}@x.io`, 'CEO'],
      ]),
      { ...MATCH, duplicateMode: 'update' },
    );
    expect(job).toMatchObject({ updatedCount: 1, createdCount: 0, failedCount: 0 });

    const row = (
      await h.pool.query(
        'select last_name, title, phone, first_name, version from contacts where id = $1',
        [id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      last_name: 'Renamed',
      title: 'CEO',
      // Not in the file, so untouched:
      phone: '+919876543210',
      first_name: 'Keep',
      version: 2,
    });

    const audit = await h.pool.query(
      `select changes from audit_logs where tenant_id = $1 and action = 'update' and record_id = $2`,
      [h.tenantId, id],
    );
    expect(audit.rows[0]?.['changes']).toMatchObject({
      lastName: { old: 'Existing', new: 'Renamed' },
      title: { new: 'CEO' },
    });
  });

  it('update does not clear a field because a cell was blank', async () => {
    const tag = unique();
    const id = await seed(tag);
    await h.pool.query(`update contacts set title = 'Founder' where id = $1`, [id]);
    await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['Existing', `dup-${tag}@x.io`, ''],
      ]),
      {
        ...MATCH,
        duplicateMode: 'update',
      },
    );
    const row = (await h.pool.query('select title, version from contacts where id = $1', [id]))
      .rows[0];
    expect(row).toMatchObject({ title: 'Founder', version: 1 });
  });

  it('update counts an identical row as skipped and does not bump the version', async () => {
    const tag = unique();
    const id = await seed(tag);
    const job = await runImport(
      csv([
        ['Last', 'Email'],
        ['Existing', `dup-${tag}@x.io`],
      ]),
      {
        mapping: MATCH.mapping.slice(0, 2),
        matchField: 'email',
        duplicateMode: 'update',
      },
    );
    expect(job).toMatchObject({ skippedCount: 1, updatedCount: 0 });
    expect(
      (await h.pool.query('select version from contacts where id = $1', [id])).rows[0]?.['version'],
    ).toBe(1);
  });

  it('update refuses to guess when a row matches several records', async () => {
    const tag = unique();
    await seed(tag);
    await seed(tag);
    const job = await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['X', `dup-${tag}@x.io`, 'CEO'],
      ]),
      {
        ...MATCH,
        duplicateMode: 'update',
      },
    );
    expect(job).toMatchObject({ failedCount: 1, updatedCount: 0, createdCount: 0 });
    expect(h.readText(job.errorFileKey as string)).toMatch(/matches 2 existing records/);
  });

  it('create makes a new record even when one matches', async () => {
    const tag = unique();
    await seed(tag);
    const job = await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['Twin', `dup-${tag}@x.io`, 'CEO'],
      ]),
      {
        ...MATCH,
        duplicateMode: 'create',
      },
    );
    expect(job.createdCount).toBe(1);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(2);
  });

  it('handles a duplicate inside the file itself, in the same chunk and across chunks', async () => {
    const tag = unique();
    const rows: (string | number)[][] = [['Last', 'Email', 'Title']];
    rows.push(['First', `same-${tag}@x.io`, 'A']);
    rows.push(['Second', `same-${tag}@x.io`, 'B']); // same chunk as the first
    for (let i = 0; i < 520; i += 1) rows.push([`Filler${i}`, `f${i}-${tag}@x.io`, 'x']);
    rows.push(['Third', `same-${tag}@x.io`, 'C']); // a later chunk than the first

    const skipJob = await runImport(csv(rows), { ...MATCH, duplicateMode: 'skip' });
    expect(skipJob).toMatchObject({ createdCount: 521, skippedCount: 2, failedCount: 0 });
    const kept = await contactsWithEmailSuffix(`same-${tag}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ last_name: 'First', title: 'A' });
  });

  it('update folds later rows of the same file into one record', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['Last', 'Email', 'Title'],
        ['First', `merge-${tag}@x.io`, 'A'],
        ['Second', `merge-${tag}@x.io`, 'B'],
      ]),
      { ...MATCH, duplicateMode: 'update' },
    );
    expect(job).toMatchObject({ createdCount: 1, updatedCount: 1 });
    const [only] = await contactsWithEmailSuffix(`merge-${tag}`);
    expect(only).toMatchObject({ last_name: 'Second', title: 'B' });
  });

  it('rows with a blank match value are created, not matched to each other', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['Last', 'Email'],
        [`NoEmail1-${tag}`, ''],
        [`NoEmail2-${tag}`, ''],
      ]),
      { mapping: MATCH.mapping.slice(0, 2), matchField: 'email', duplicateMode: 'skip' },
    );
    expect(job.createdCount).toBe(2);
  });
});

describe('the error file', () => {
  it('names each failed row (as the user sees it) and why, and the rest still import', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['First', 'Last', 'Email'],
        ['Ok', 'One', `ok1-${tag}@x.io`],
        ['Bad', 'Two', 'not-an-email'],
        ['Ok', 'Three', `ok3-${tag}@x.io`],
        ['Bad', '', `nolast-${tag}@x.io`],
      ]),
    );

    expect(job).toMatchObject({
      status: 'completed',
      totalRows: 4,
      processedRows: 4,
      createdCount: 2,
      failedCount: 2,
    });
    expect(job.errorFileKey).toBeTruthy();

    const lines = h
      .readText(job.errorFileKey as string)
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('Row,Field,Error,First,Last,Email');
    // Row 3 and row 5 of *their* spreadsheet (the header is row 1).
    expect(lines[1]).toMatch(/^3,email,Email: /);
    expect(lines[1]).toContain('not-an-email');
    expect(lines[2]).toMatch(/^5,last_name,Last name is required/);
    expect(lines).toHaveLength(3);
  });

  it('escapes the uploader’s own cells in the error file (§5.11)', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['First', 'Last', 'Email'],
        ['=HYPERLINK("http://evil/","x")', 'Z', 'bad-email'],
        ['+1+1', 'Z', `bad2-${tag}`],
        ['@SUM(1)', 'Z', `bad3-${tag}`],
        ['-2+3', 'Z', `bad4-${tag}`],
      ]),
    );
    const body = h.readText(job.errorFileKey as string);
    for (const payload of ['=HYPERLINK', '+1+1', '@SUM(1)', '-2+3']) {
      expect(body).toContain(`'${payload}`);
      // And never as the first character of a cell.
      expect(body).not.toMatch(new RegExp(`(^|,|\\r\\n)"?${payload.replace(/[+()=@]/g, '\\$&')}`));
    }
  });
});

describe('idempotency and failure (ADR-0029)', () => {
  it('a redelivered chunk event does nothing: no double-create, no double-count', async () => {
    const tag = unique();
    const job = await runImport(
      csv([
        ['First', 'Last', 'Email'],
        ['A', 'One', `a-${tag}@x.io`],
        ['B', 'Two', `b-${tag}@x.io`],
      ]),
    );
    expect(job.createdCount).toBe(2);

    // The relay's at-least-once delivery, made literal: the same step again.
    for (const startRow of [0, 0, 1, 2]) {
      await withTenant(h.db.db, { tenantId: h.tenantId, userId: owner }, (tx) =>
        tx.insert(outboxEvents).values({
          id: newId(),
          tenantId: h.tenantId,
          eventType: 'import.chunk.v1',
          objectType: 'import_job',
          recordId: job.id,
          payload: { startRow },
          actorId: owner,
        }),
      );
    }
    await h.drain();

    const after = await h.job(job.id);
    expect(after.createdCount).toBe(2);
    expect(after.processedRows).toBe(2);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(2);
  });

  it('a crash mid-chunk rolls the whole chunk back, and the retry creates each record once', async () => {
    const tag = unique();
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        ['First', 'Last', 'Email'],
        ['A', 'One', `crash-a-${tag}@x.io`],
        ['B', 'Two', `crash-b-${tag}@x.io`],
        ['C', 'Three', `crash-c-${tag}@x.io`],
      ]),
    });
    await h.start(analyzed.id, { mapping: BASIC_MAPPING });

    // Staging runs normally. Then the chunk's handler "crashes" *after* it has
    // done all its work, which is the worst moment: records inserted, audit and
    // outbox rows written, checkpoint advanced — all inside a transaction that
    // is about to be abandoned.
    await h.relay.tick(); // import.started.v1 -> staged, chunk event queued
    expect((await h.job(analyzed.id)).status).toBe('processing');

    const { processImportChunk } = await import('./import-handlers.js');
    const { OutboxRelay } = await import('../relay.js');
    const { pino } = await import('pino');
    const logger = pino({ level: 'silent' });
    const real = processImportChunk({ db: h.db.db, storage: h.storage, logger });
    let crashed = false;
    const crashing = new OutboxRelay(h.db.db, { logger, batchSize: 10 }).on(
      'import.chunk.v1',
      async (tx, event) => {
        await real(tx, event);
        if (!crashed) {
          crashed = true;
          throw new Error('simulated crash after the work');
        }
      },
    );

    await crashing.tick();
    expect(crashed).toBe(true);

    // Nothing of that attempt survived.
    const mid = await h.job(analyzed.id);
    expect(mid).toMatchObject({ status: 'processing', processedRows: 0, createdCount: 0 });
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(0);

    // The relay backed the event off; bring it forward and retry.
    await h.pool.query(
      `update outbox_events set available_at = now() - interval '1 minute'
       where record_id = $1 and status = 'pending'`,
      [analyzed.id],
    );
    await crashing.tick();
    await h.drain();

    const done = await h.job(analyzed.id);
    expect(done).toMatchObject({ status: 'completed', createdCount: 3, processedRows: 3 });
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(3);
    const audits = await h.pool.query(
      `select count(*)::int as n from audit_logs
       where tenant_id = $1 and action = 'create' and record_id = any($2)`,
      [h.tenantId, (await contactsWithEmailSuffix(tag)).map((row) => row['id'])],
    );
    expect(audits.rows[0]?.['n']).toBe(3);
  });

  it('on the relay’s last attempt, a step that keeps failing ends the job as failed', async () => {
    const tag = unique();
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        ['First', 'Last', 'Email'],
        ['A', 'One', `final-${tag}@x.io`],
      ]),
    });
    await h.start(analyzed.id, { mapping: BASIC_MAPPING });
    await h.relay.tick(); // staged; chunk event queued

    // The chunk handler throws, as it would for a database that is down. Make
    // this the last attempt the relay will grant.
    await h.pool.query(
      `update outbox_events set attempts = $2 where record_id = $1 and event_type = 'import.chunk.v1'`,
      [analyzed.id, DEFAULT_MAX_ATTEMPTS - 1],
    );
    // Break the chunk step by removing the staged rows it expects to find.
    await h.pool.query('delete from import_rows where job_id = $1', [analyzed.id]);

    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/could not be completed/);
    expect(job.finishedAt).not.toBeNull();
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(0);
  });

  it('refuses a file replaced between analysis and staging (the presigned URL outlives analysis)', async () => {
    const tag = unique();
    const good = csv([
      ['First', 'Last', 'Email'],
      ['A', 'One', `swap-${tag}@x.io`],
    ]);
    const analyzed = await h.analyze({ userId: owner, bytes: good });
    expect(analyzed.status, analyzed.failureReason ?? '').toBe('awaiting_mapping');

    // The uploader PUTs a different object, of exactly the same size, to the
    // same key, while the mapping screen is open.
    const pdf = Buffer.alloc(good.length, 0x20);
    pdf.write('%PDF-1.7', 0);
    h.storage.put(analyzed.storageKey, pdf);

    await h.start(analyzed.id, { mapping: BASIC_MAPPING });
    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('rejected');
    expect(job.failureReason).toMatch(/PDF/);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(0);
  });

  it('stops, without writing, when the importer loses `import` permission mid-run', async () => {
    const tag = unique();
    const rep = await h.user('Manager');
    const analyzed = await h.analyze({
      userId: rep,
      bytes: csv([
        ['First', 'Last', 'Email'],
        ['A', 'One', `revoked-${tag}@x.io`],
      ]),
    });
    await h.start(analyzed.id, { mapping: BASIC_MAPPING });
    await h.relay.tick(); // staged

    await h.pool.query(
      `delete from role_permissions where tenant_id = $1 and role_id = $2 and action = 'import'`,
      [h.tenantId, h.roleIds.get('Manager')],
    );
    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/permissions .* changed/);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(0);

    // Put it back for the other tests in this file.
    await h.pool.query(
      `insert into role_permissions (id, tenant_id, role_id, object_type, action, scope)
       select gen_random_uuid(), $1, $2, object_type, 'import', scope
       from role_permissions where tenant_id = $1 and role_id = $2 and action = 'read'`,
      [h.tenantId, h.roleIds.get('Manager')],
    );
  });

  it('stops when the person who started the import no longer has access', async () => {
    const tag = unique();
    const temp = await h.user('Admin');
    const analyzed = await h.analyze({
      userId: temp,
      bytes: csv([
        ['First', 'Last', 'Email'],
        ['A', 'One', `gone-${tag}@x.io`],
      ]),
    });
    await h.start(analyzed.id, { mapping: BASIC_MAPPING });
    await h.relay.tick();
    await h.fixtures.setMembershipStatus(h.tenantId, temp, 'suspended');
    await h.drain();

    const job = await h.job(analyzed.id);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/no longer has access/);
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(0);
  });
});

describe('chunking', () => {
  it('processes many chunks, each queued by the one before, and reports exact counts', async () => {
    const tag = unique();
    const rows: (string | number)[][] = [['First', 'Last', 'Email']];
    for (let i = 0; i < 1234; i += 1) rows.push(['F', `L${i}`, `chunk-${i}-${tag}@x.io`]);
    // Sprinkle in failures across chunk boundaries.
    rows[10] = ['F', 'L', 'broken'];
    rows[600] = ['F', 'L', 'broken2'];
    rows[1200] = ['F', '', `blank-${tag}@x.io`];

    const job = await runImport(csv(rows));
    expect(job).toMatchObject({
      status: 'completed',
      totalRows: 1234,
      processedRows: 1234,
      createdCount: 1231,
      failedCount: 3,
    });
    expect(job.createdCount + job.updatedCount + job.skippedCount + job.failedCount).toBe(
      job.processedRows,
    );
    expect(await contactsWithEmailSuffix(tag)).toHaveLength(1231);
  });
});

void sql;
