import { newId } from '@crm/core';
import { loadActor, loadFieldDefinitions, withTenant } from '@crm/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';
import { processChunk } from './import-rows.js';

/**
 * Importing deals (ADR-0070, CLAUDE.md §10).
 *
 * A deal row is the most connected thing an import writes: a pipeline and stage by name, an account,
 * a contact, an owner, an amount, and the stage rules on top. These tests run the real pipeline and
 * read back what was written, and pin the places a deals import could go wrong in a way that is
 * quiet: a deal in the wrong stage, a closed deal with the wrong date, a duplicate nobody was told of.
 */
let h: WorkerHarness;
let otherTenantId: string;
let owner: string;
let defaultPipeline: {
  id: string;
  name: string;
  stages: { id: string; name: string; stageType: string }[];
};

const unique = (): string => newId().replaceAll('-', '').slice(-10);

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Import Deals' });
  owner = await h.user('Owner');
  otherTenantId = (await h.fixtures.createTenant({ name: 'Import Deals B' })).tenantId;
  const pipelines = await h.fixtures.pipelinesFor(h.tenantId);
  const found = pipelines.find((pipeline) => pipeline.isDefault);
  if (found === undefined) throw new Error('The workspace has no default pipeline');
  defaultPipeline = found;
});

afterAll(async () => {
  await h.close();
});

const HEAD = ['Name', 'Amount', 'Pipeline', 'Stage', 'Account', 'Contact', 'Owner', 'Lost reason'];
const MAP = [
  { column: 0, field: 'name' },
  { column: 1, field: 'amount' },
  { column: 2, field: 'pipeline_id' },
  { column: 3, field: 'stage_id' },
  { column: 4, field: 'account_id' },
  { column: 5, field: 'primary_contact_id' },
  { column: 6, field: 'owner_id' },
  { column: 7, field: 'lost_reason' },
];

async function importDeals(
  userId: string,
  rows: (string | number)[][],
  options: {
    mapping?: { column: number; field: string }[];
    duplicateMode?: 'skip' | 'update' | 'create';
    matchField?: string | null;
  } = {},
) {
  const analyzed = await h.analyze({ userId, objectType: 'deal', bytes: csv(rows) });
  expect(analyzed.status, analyzed.failureReason ?? '').toBe('awaiting_mapping');
  await h.start(analyzed.id, {
    mapping: options.mapping ?? MAP,
    duplicateMode: options.duplicateMode ?? 'create',
    matchField: options.matchField ?? null,
  });
  await h.drain();
  return h.job(analyzed.id);
}

async function deal(name: string): Promise<Record<string, unknown>> {
  const row = (
    await h.pool.query(
      `select * from deals where tenant_id = $1 and name = $2 and deleted_at is null`,
      [h.tenantId, name],
    )
  ).rows[0];
  if (row === undefined) throw new Error(`No deal ${name}`);
  return row;
}

const dealCount = async (name: string): Promise<number> =>
  Number(
    (
      await h.pool.query(
        `select count(*)::int as n from deals where tenant_id = $1 and name = $2 and deleted_at is null`,
        [h.tenantId, name],
      )
    ).rows[0]?.['n'],
  );

const stageNamed = (type: string): { id: string; name: string } => {
  const found = defaultPipeline.stages.find((stage) => stage.stageType === type);
  if (found === undefined) throw new Error(`No ${type} stage`);
  return found;
};

describe('where a deal goes: pipeline and stage by name', () => {
  it('places each row by the names it gives, ignoring case, and by default when it gives none', async () => {
    const tag = unique();
    const open = defaultPipeline.stages.filter((stage) => stage.stageType === 'open');
    const second = open[1] ?? open[0]!;

    const job = await importDeals(owner, [
      HEAD,
      [
        `Named ${tag}`,
        '1000 INR',
        defaultPipeline.name.toUpperCase(),
        second.name.toLowerCase(),
        '',
        '',
        '',
        '',
      ],
      [`Blank ${tag}`, '', '', '', '', '', '', ''],
    ]);
    expect(job).toMatchObject({ status: 'completed', createdCount: 2, failedCount: 0 });

    expect(await deal(`Named ${tag}`)).toMatchObject({
      pipeline_id: defaultPipeline.id,
      stage_id: second.id,
    });
    // No pipeline and no stage: the default pipeline's first open stage, as for a form.
    expect(await deal(`Blank ${tag}`)).toMatchObject({
      pipeline_id: defaultPipeline.id,
      stage_id: open[0]!.id,
    });
  });

  it('keeps two pipelines that share a stage name apart: the pipeline settles which is meant', async () => {
    const tag = unique();
    const wholesaleName = `Wholesale ${tag}`;
    const made = await h.fixtures.createPipeline(h.tenantId, wholesaleName, [
      { name: 'Enquiry', stageType: 'open', probability: 5 },
      { name: 'Won', stageType: 'won', probability: 100 },
      { name: 'Lost', stageType: 'lost', probability: 0 },
    ]);

    const job = await importDeals(owner, [
      HEAD,
      [`W ${tag}`, '', wholesaleName, 'Enquiry', '', '', '', ''],
      [`W2 ${tag}`, '', wholesaleName, '', '', '', '', ''],
    ]);
    expect(job).toMatchObject({ createdCount: 2, failedCount: 0 });
    expect(await deal(`W ${tag}`)).toMatchObject({
      pipeline_id: made.pipelineId,
      stage_id: made.stageIds[0],
    });
    expect(await deal(`W2 ${tag}`)).toMatchObject({ stage_id: made.stageIds[0] });
  });

  it('never guesses: an unknown pipeline or stage fails that row and says which name', async () => {
    const tag = unique();
    const job = await importDeals(owner, [
      HEAD,
      [`Good ${tag}`, '', '', '', '', '', '', ''],
      [`NoPipe ${tag}`, '', `Nowhere ${tag}`, '', '', '', '', ''],
      [`NoStage ${tag}`, '', '', `Nothing ${tag}`, '', '', '', ''],
    ]);
    expect(job).toMatchObject({ createdCount: 1, failedCount: 2 });
    const errors = h.readText(job.errorFileKey as string);
    expect(errors).toContain(`no pipeline is named`);
    expect(errors).toContain(`Nowhere ${tag}`);
    expect(errors).toContain(`has no stage named`);
    expect(errors).toContain(`Nothing ${tag}`);
    expect(await dealCount(`NoPipe ${tag}`)).toBe(0);
  });

  it('applies the stage rules the API applies: won is 100% and closed, lost needs a reason', async () => {
    const tag = unique();
    const won = stageNamed('won');
    const lost = stageNamed('lost');
    const open = stageNamed('open');

    const job = await importDeals(owner, [
      HEAD,
      [`Won ${tag}`, '', '', won.name, '', '', '', ''],
      [`Lost ok ${tag}`, '', '', lost.name, '', '', '', 'Went with a rival'],
      [`Lost bad ${tag}`, '', '', lost.name, '', '', '', ''],
      [`Open reason ${tag}`, '', '', open.name, '', '', '', 'Because'],
    ]);
    expect(job).toMatchObject({ createdCount: 2, failedCount: 2 });

    const wonRow = await deal(`Won ${tag}`);
    expect(wonRow).toMatchObject({ probability: 100, lost_reason: null });
    expect(Date.now() - (wonRow['closed_at'] as Date).getTime()).toBeLessThan(10 * 60_000);
    expect(await deal(`Lost ok ${tag}`)).toMatchObject({
      probability: 0,
      lost_reason: 'Went with a rival',
    });
    const errors = h.readText(job.errorFileKey as string);
    expect(errors).toContain('A lost reason is required');
    expect(errors).toContain('can only be given for a deal in a lost stage');
  });
});

describe('amounts, accounts, contacts and owners', () => {
  it('writes the amount exactly, in the currency it names or the workspace currency', async () => {
    const tag = unique();
    const job = await importDeals(owner, [
      HEAD,
      [`Own currency ${tag}`, '1,500.75 USD', '', '', '', '', '', ''],
      [`Plain ${tag}`, '2500', '', '', '', '', '', ''],
      [`Bad ${tag}`, 'lots', '', '', '', '', '', ''],
    ]);
    expect(job).toMatchObject({ createdCount: 2, failedCount: 1 });
    expect(await deal(`Own currency ${tag}`)).toMatchObject({
      amount_minor: 150075n,
      currency: 'USD',
    });
    const plain = await deal(`Plain ${tag}`);
    expect(plain['amount_minor']).toBe(250000n);
    expect(typeof plain['currency']).toBe('string');
  });

  it('links the account, the primary contact and the owner, and says which cell is wrong', async () => {
    const tag = unique();
    const member = await h.user('Sales Rep');
    const account = await h.fixtures.createAccount(h.tenantId, {
      name: `Acme ${tag}`,
      ownerId: owner,
    });
    const contact = await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'Buyer',
      email: `buyer-${tag}@x.io`,
    });
    const memberEmail = await h.fixtures.emailFor(member);

    const job = await importDeals(owner, [
      HEAD,
      [`Linked ${tag}`, '', '', '', `Acme ${tag}`, `BUYER-${tag}@x.io`, memberEmail, ''],
      [`NoContact ${tag}`, '', '', '', '', `ghost-${tag}@x.io`, '', ''],
      [`NoOwner ${tag}`, '', '', '', '', '', `nobody-${tag}@x.io`, ''],
    ]);
    expect(job).toMatchObject({ createdCount: 1, failedCount: 2 });
    expect(await deal(`Linked ${tag}`)).toMatchObject({
      account_id: account,
      primary_contact_id: contact,
      owner_id: member,
    });
    const errors = h.readText(job.errorFileKey as string);
    expect(errors).toContain('no contact has the e-mail address');
    expect(errors).toContain('Owner: unknown member');
  });

  it('does not find an account or a contact in another workspace', async () => {
    const tag = unique();
    await h.fixtures.createAccount(otherTenantId, { name: `Theirs ${tag}` });
    await h.fixtures.createContact(otherTenantId, {
      lastName: 'Theirs',
      email: `theirs-${tag}@x.io`,
    });
    const job = await importDeals(owner, [
      HEAD,
      [`A ${tag}`, '', '', '', `Theirs ${tag}`, '', '', ''],
      [`B ${tag}`, '', '', '', '', `theirs-${tag}@x.io`, '', ''],
    ]);
    expect(job).toMatchObject({ createdCount: 0, failedCount: 2 });
  });
});

describe('original dates on a deal', () => {
  const DATED = [
    { column: 0, field: 'name' },
    { column: 1, field: 'stage_id' },
    { column: 2, field: 'created_at' },
    { column: 3, field: 'closed_at' },
  ];
  const DHEAD = ['Name', 'Stage', 'Created', 'Closed'];

  it('sets when a won deal was created and when it closed, for someone who holds the right', async () => {
    const tag = unique();
    const won = stageNamed('won');
    const job = await importDeals(
      owner,
      [DHEAD, [`Old win ${tag}`, won.name, '2023-02-01T10:00:00Z', '2023-05-20T12:00:00Z']],
      { mapping: DATED },
    );
    expect(job).toMatchObject({ createdCount: 1, failedCount: 0 });
    const row = await deal(`Old win ${tag}`);
    expect((row['created_at'] as Date).toISOString()).toBe('2023-02-01T10:00:00.000Z');
    expect((row['closed_at'] as Date).toISOString()).toBe('2023-05-20T12:00:00.000Z');
    expect(row['probability']).toBe(100);
  });

  it('refuses a closed date without a created date, on an open stage, or before the created date', async () => {
    const tag = unique();
    const won = stageNamed('won');
    const open = stageNamed('open');
    const job = await importDeals(
      owner,
      [
        DHEAD,
        [`Alone ${tag}`, won.name, '', '2023-05-20'],
        [`Open ${tag}`, open.name, '2023-01-01', '2023-05-20'],
        [`Backwards ${tag}`, won.name, '2023-06-01', '2023-05-20'],
      ],
      { mapping: DATED },
    );
    expect(job).toMatchObject({ createdCount: 0, failedCount: 3 });
    const errors = h.readText(job.errorFileKey as string);
    expect(errors).toContain('also give the Created date');
    expect(errors).toContain('only a deal in a won or lost stage');
    expect(errors).toContain('cannot be before the created date');
  });

  it('refuses the dates to a manager, who may import deals but not bring history', async () => {
    const tag = unique();
    const manager = await h.user('Manager');
    const analyzed = await h.analyze({
      userId: manager,
      objectType: 'deal',
      bytes: csv([DHEAD, [`Mgr ${tag}`, stageNamed('won').name, '2023-01-01', '2023-02-01']]),
    });
    await h.start(analyzed.id, { mapping: DATED });
    await h.drain();
    expect((await h.job(analyzed.id)).status).toBe('failed');
    expect(await dealCount(`Mgr ${tag}`)).toBe(0);
  });
});

describe('duplicates are never silent', () => {
  it('skips a deal with the same name on the same account, says so in the file, and keeps a different account', async () => {
    const tag = unique();
    const first = await h.fixtures.createAccount(h.tenantId, {
      name: `First ${tag}`,
      ownerId: owner,
    });
    const second = await h.fixtures.createAccount(h.tenantId, {
      name: `Second ${tag}`,
      ownerId: owner,
    });
    await h.fixtures.createDeal(h.tenantId, {
      pipelineId: defaultPipeline.id,
      stageId: stageNamed('open').id,
      name: `Renewal ${tag}`,
      accountId: first,
      ownerId: owner,
    });

    const job = await importDeals(
      owner,
      [
        HEAD,
        [`Renewal ${tag}`, '', '', '', `First ${tag}`, '', '', ''],
        [`Renewal ${tag}`, '', '', '', `Second ${tag}`, '', '', ''],
        [`Renewal ${tag}`, '', '', '', `Second ${tag}`, '', '', ''],
      ],
      { duplicateMode: 'skip', matchField: 'name' },
    );
    // One skipped (exists), one created (other account), one skipped (repeats the row above).
    expect(job).toMatchObject({ createdCount: 1, skippedCount: 2, failedCount: 0 });
    expect(job.errorFileKey).not.toBeNull();
    const file = h.readText(job.errorFileKey as string);
    expect(file.match(/Skipped: a deal named/g)).toHaveLength(2);
    expect(file).toContain('on this account');

    const onSecond = await h.pool.query(
      `select count(*)::int as n from deals where tenant_id = $1 and name = $2 and account_id = $3`,
      [h.tenantId, `Renewal ${tag}`, second],
    );
    expect(onSecond.rows[0]?.['n']).toBe(1);
  });

  it('with an ID column, importing the same file again updates instead of doubling', async () => {
    const tag = unique();
    const options = {
      mapping: [
        { column: 0, field: 'name' },
        { column: 1, field: 'amount' },
        { column: 2, field: 'external_id' },
      ],
      duplicateMode: 'update' as const,
      matchField: 'external_id',
    };
    const head = ['Name', 'Amount', 'ID'];

    const first = await importDeals(
      owner,
      [head, [`Idem ${tag}`, '100 INR', `crm-${tag}`]],
      options,
    );
    expect(first).toMatchObject({ createdCount: 1, updatedCount: 0 });

    const again = await importDeals(
      owner,
      [head, [`Idem ${tag}`, '250 INR', `crm-${tag}`]],
      options,
    );
    expect(again).toMatchObject({ createdCount: 0, updatedCount: 1 });
    expect(await dealCount(`Idem ${tag}`)).toBe(1);
    expect(await deal(`Idem ${tag}`)).toMatchObject({
      amount_minor: 25000n,
      external_id: `crm-${tag}`,
      version: 2,
    });

    const same = await importDeals(
      owner,
      [head, [`Idem ${tag}`, '250 INR', `crm-${tag}`]],
      options,
    );
    expect(same).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
  });

  it('in skip mode an ID that exists is skipped and said so', async () => {
    const tag = unique();
    const opts = {
      mapping: [
        { column: 0, field: 'name' },
        { column: 1, field: 'external_id' },
      ],
      duplicateMode: 'skip' as const,
      matchField: 'external_id',
    };
    await importDeals(
      owner,
      [
        ['Name', 'ID'],
        [`Once ${tag}`, `id-${tag}`],
      ],
      opts,
    );
    const job = await importDeals(
      owner,
      [
        ['Name', 'ID'],
        [`Once ${tag}`, `id-${tag}`],
      ],
      opts,
    );
    expect(job).toMatchObject({ createdCount: 0, skippedCount: 1 });
    expect(h.readText(job.errorFileKey as string)).toContain('Skipped: a deal with the ID');
  });

  it('never matches an ID in another workspace', async () => {
    const tag = unique();
    const theirs = await h.fixtures.createPipeline(otherTenantId, `Theirs ${tag}`, [
      { name: 'New', stageType: 'open', probability: 10 },
    ]);
    const theirDeal = await h.fixtures.createDeal(otherTenantId, {
      pipelineId: theirs.pipelineId,
      stageId: theirs.stageIds[0]!,
      name: `Theirs ${tag}`,
    });
    await h.pool.query('update deals set external_id = $2 where id = $1', [
      theirDeal,
      `shared-${tag}`,
    ]);

    const job = await importDeals(
      owner,
      [
        ['Name', 'ID'],
        [`Ours ${tag}`, `shared-${tag}`],
      ],
      {
        mapping: [
          { column: 0, field: 'name' },
          { column: 1, field: 'external_id' },
        ],
        duplicateMode: 'update',
        matchField: 'external_id',
      },
    );
    expect(job).toMatchObject({ createdCount: 1, updatedCount: 0 });
    expect(
      (await h.pool.query('select name from deals where id = $1', [theirDeal])).rows[0]?.['name'],
    ).toBe(`Theirs ${tag}`);
  });
});

describe('updating an existing deal', () => {
  it('moves it within its pipeline by the stage rules, and refuses to move it to another pipeline', async () => {
    const tag = unique();
    const open = stageNamed('open');
    const won = stageNamed('won');
    const id = await h.fixtures.createDeal(h.tenantId, {
      pipelineId: defaultPipeline.id,
      stageId: open.id,
      name: `Moving ${tag}`,
      ownerId: owner,
    });
    await h.pool.query('update deals set external_id = $2 where id = $1', [id, `mv-${tag}`]);
    const other = await h.fixtures.createPipeline(h.tenantId, `Other ${tag}`, [
      { name: 'New', stageType: 'open', probability: 10 },
    ]);

    const opts = {
      mapping: [
        { column: 0, field: 'external_id' },
        { column: 1, field: 'pipeline_id' },
        { column: 2, field: 'stage_id' },
        { column: 3, field: 'name' },
      ],
      duplicateMode: 'update' as const,
      matchField: 'external_id',
    };
    const head = ['ID', 'Pipeline', 'Stage', 'Name'];

    const refused = await importDeals(
      owner,
      [head, [`mv-${tag}`, `Other ${tag}`, 'New', `Moving ${tag}`]],
      opts,
    );
    expect(refused).toMatchObject({ updatedCount: 0, failedCount: 1 });
    expect(h.readText(refused.errorFileKey as string)).toContain('another pipeline');
    expect((await deal(`Moving ${tag}`))['pipeline_id']).toBe(defaultPipeline.id);
    expect(other.pipelineId).toBeTruthy();

    const moved = await importDeals(
      owner,
      [head, [`mv-${tag}`, '', won.name, `Moving ${tag}`]],
      opts,
    );
    expect(moved).toMatchObject({ updatedCount: 1, failedCount: 0 });
    const row = await deal(`Moving ${tag}`);
    expect(row).toMatchObject({ stage_id: won.id, probability: 100 });
    expect(row['closed_at']).not.toBeNull();
  });
});

describe('what a deals import is held to', () => {
  it('a check reports the same and writes nothing, skipped notes included', async () => {
    const tag = unique();
    await h.fixtures.createDeal(h.tenantId, {
      pipelineId: defaultPipeline.id,
      stageId: stageNamed('open').id,
      name: `Checked ${tag}`,
      ownerId: owner,
    });
    const analyzed = await h.analyze({
      userId: owner,
      objectType: 'deal',
      bytes: csv([
        HEAD,
        [`Checked ${tag}`, '', '', '', '', '', '', ''],
        [`Fresh ${tag}`, '', '', '', '', '', '', ''],
      ]),
    });
    const checkId = await h.check(analyzed.id, {
      mapping: MAP,
      duplicateMode: 'skip',
      matchField: 'name',
    });
    await h.drain();
    const check = await h.job(checkId);
    expect(check).toMatchObject({ status: 'completed', createdCount: 1, skippedCount: 1 });
    expect(h.readText(check.errorFileKey as string)).toContain('Skipped: a deal named');
    expect(await dealCount(`Fresh ${tag}`)).toBe(0);
  });

  it('refuses a hidden pipeline field even when the mapping check is bypassed', async () => {
    const tag = unique();
    const roleId = await h.fixtures.createRole(h.tenantId, `deal-importer-${unique()}`);
    for (const action of ['read', 'create', 'update', 'import'] as const) {
      await h.fixtures.grant(h.tenantId, roleId, 'deal', action, 'all');
    }
    await h.fixtures.setFieldPermission(h.tenantId, roleId, 'deal', 'stage_id', 'hidden');
    const user = (await h.fixtures.createUser(h.tenantId, roleId)).userId;

    const result = await withTenant(h.db.db, { tenantId: h.tenantId, userId: user }, async (tx) => {
      const actor = (await loadActor(tx, user, h.tenantId))!;
      const fields = await loadFieldDefinitions(tx, h.tenantId, 'deal');
      return processChunk(
        tx,
        {
          actor,
          jobId: newId(),
          objectType: 'deal',
          fields,
          mapping: [
            { column: 0, field: 'name' },
            { column: 1, field: 'stage_id' },
          ],
          duplicateMode: 'create',
          matchField: null,
        },
        [{ rowNumber: 1, sourceRow: 2, cells: [`Hidden ${tag}`, stageNamed('won').name] }],
      );
    });
    expect(result).toMatchObject({ created: 0, failed: 1 });
    expect(result.errors[0]?.message).toMatch(/permission to write this field/);
  });

  it('records the deal in the audit log and announces it with its stage, like a deal made in a form', async () => {
    const tag = unique();
    await importDeals(owner, [HEAD, [`Announced ${tag}`, '500 INR', '', '', '', '', '', '']]);
    const row = await deal(`Announced ${tag}`);
    const audit = await h.pool.query(
      `select changes from audit_logs where tenant_id = $1 and action = 'create' and record_id = $2`,
      [h.tenantId, row['id']],
    );
    const changes = audit.rows[0]?.['changes'] as Record<string, { new?: unknown }>;
    expect(changes['name']?.new).toBe(`Announced ${tag}`);
    expect(changes['amountMinor']?.new).toBe('50000');
    expect(changes['importJobId']).toBeDefined();

    const event = await h.pool.query(
      `select payload from outbox_events where tenant_id = $1 and record_id = $2 and event_type = 'deal.created.v1'`,
      [h.tenantId, row['id']],
    );
    expect(event.rows[0]?.['payload']).toMatchObject({
      pipelineId: row['pipeline_id'],
      stageId: row['stage_id'],
      stageName: String(defaultPipeline.stages.find((stage) => stage.id === row['stage_id'])?.name),
    });
  });
});
