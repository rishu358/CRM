import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { closePool } from './pool-close.js';
import { Fixtures } from './testing/index.js';
import { packageRootFrom } from './package-root.js';

/**
 * Migration 0024 applied to a database that already has companies in it
 * (MVP_SPEC M5, M9; ADR-0062), and what it makes the database refuse.
 *
 * The statements that exist for *existing* data (granting Owner and Admin the new `pipeline` right,
 * building the unique indexes over stages that are already there) run against zero rows in every
 * other test. So this builds the real situation: migrate to just before 0024, create companies with
 * pipelines, stages and deals the way the older code did, apply 0024, and look. The second half
 * speaks to the database directly, as an import or a script would, to show the three guarantees
 * hold without the service: a stage holding deals cannot be retired, no deal can be put in a retired
 * stage, and two stages in use cannot share a position or a name.
 */
const packageRoot = packageRootFrom(import.meta.url);
const MIGRATIONS = join(packageRoot, 'migrations');
const DATABASE = 'crm_backfill_0024';

let admin: pg.Pool;
let pool: pg.Pool;
let fixtures: Fixtures;
let beforeDir: string;
let throughDir: string;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

interface Company {
  readonly tenantId: string;
  readonly ownerRole: string;
  readonly adminRole: string;
  readonly repRole: string;
  readonly customRole: string;
  readonly pipelineId: string;
  readonly stageIds: string[];
}

async function company(name: string): Promise<Company> {
  const tenantId = (await fixtures.createTenant({ name })).tenantId;
  const made = await fixtures.createPipeline(tenantId, 'Sales', [
    { name: 'New', stageType: 'open', probability: 10 },
    { name: 'Proposal', stageType: 'open', probability: 50 },
    { name: 'Won', stageType: 'won', probability: 100 },
    { name: 'Lost', stageType: 'lost', probability: 0 },
  ]);
  return {
    tenantId,
    ownerRole: await fixtures.createRole(tenantId, 'Owner', { isSystem: true }),
    adminRole: await fixtures.createRole(tenantId, 'Admin', { isSystem: true }),
    repRole: await fixtures.createRole(tenantId, 'Sales Rep', { isSystem: true }),
    customRole: await fixtures.createRole(tenantId, 'Owner lookalike'),
    pipelineId: made.pipelineId,
    stageIds: made.stageIds,
  };
}

let first: Company;
let second: Company;
let dealInProposal: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  admin = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);

  const superuserUrl = urlFor(urls.superuser, DATABASE);
  pool = new pg.Pool({ connectionString: superuserUrl, max: 2 });
  await pool.query(
    readFileSync(join(packageRoot, 'sql', 'bootstrap', '01-extensions-and-roles.sql'), 'utf8'),
  );

  beforeDir = mkdtempSync(join(tmpdir(), 'migrations-before-0024-'));
  throughDir = mkdtempSync(join(tmpdir(), 'migrations-through-0024-'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    if (file < '0024') cpSync(join(MIGRATIONS, file), join(beforeDir, file));
    if (file < '0025') cpSync(join(MIGRATIONS, file), join(throughDir, file));
  }

  const migratorUrl = urlFor(urls.migrator, DATABASE);
  await runMigrations(migratorUrl, beforeDir);

  fixtures = new Fixtures(pool);
  first = await company('Working for months');
  second = await company('Also working');
  // A deal already sitting in a stage, as production would have.
  dealInProposal = await fixtures.createDeal(first.tenantId, {
    pipelineId: first.pipelineId,
    stageId: first.stageIds[1]!,
    name: 'Existing deal',
  });

  const result = await runMigrations(migratorUrl, throughDir);
  expect(result.applied).toEqual(['0024_pipeline_editor.sql']);
}, 180_000);

afterAll(async () => {
  await closePool(pool);
  await admin.query(`drop database if exists ${DATABASE}`);
  await closePool(admin);
  rmSync(beforeDir, { recursive: true, force: true });
  rmSync(throughDir, { recursive: true, force: true });
});

async function grantsOf(roleId: string): Promise<string[]> {
  const rows = await pool.query<{ action: string; scope: string }>(
    `select action, scope from role_permissions where role_id = $1 and object_type = 'pipeline'
      order by action`,
    [roleId],
  );
  return rows.rows.map((row) => `${row.action}:${row.scope}`);
}

describe('migration 0024 on a database that already has companies', () => {
  it('gives Owner and Admin of every existing company the pipeline grant, at all scope', async () => {
    const expected = ['create:all', 'delete:all', 'read:all', 'update:all'];
    for (const company of [first, second]) {
      expect(await grantsOf(company.ownerRole), 'owner').toEqual(expected);
      expect(await grantsOf(company.adminRole), 'admin').toEqual(expected);
    }
  });

  it('gives nobody else anything: not a rep, not a custom role that looks like the owner', async () => {
    for (const company of [first, second]) {
      expect(await grantsOf(company.repRole)).toEqual([]);
      expect(await grantsOf(company.customRole)).toEqual([]);
    }
  });

  it('keeps every grant inside its own company', async () => {
    const strays = await pool.query(
      `select 1 from role_permissions p join roles r on r.id = p.role_id
        where p.object_type = 'pipeline' and p.tenant_id <> r.tenant_id`,
    );
    expect(strays.rows).toHaveLength(0);
  });

  it('leaves the existing stages in use, at version 1, with their order untouched', async () => {
    const rows = await pool.query<{ name: string; version: number; archived_at: Date | null }>(
      `select name, version, archived_at from pipeline_stages
        where pipeline_id = $1 order by position`,
      [first.pipelineId],
    );
    expect(rows.rows.map((row) => row.name)).toEqual(['New', 'Proposal', 'Won', 'Lost']);
    for (const row of rows.rows) {
      expect(row.version).toBe(1);
      expect(row.archived_at).toBeNull();
    }
    const pipeline = await pool.query<{ version: number }>(
      `select version from pipelines where id = $1`,
      [first.pipelineId],
    );
    expect(pipeline.rows[0]?.version).toBe(1);
  });

  it('does not touch an existing deal', async () => {
    const row = await fixtures.dealRow(dealInProposal);
    expect(row?.stage_id).toBe(first.stageIds[1]);
  });
});

async function refused(sql: string, params: unknown[], constraint: string): Promise<void> {
  const error = await pool.query(sql, params).then(
    () => null,
    (caught: unknown) => caught as { code?: string; constraint?: string; message?: string },
  );
  expect(error, `expected the database to refuse: ${sql}`).not.toBeNull();
  expect(error?.constraint ?? error?.message).toContain(constraint);
}

describe('what the database refuses without the service', () => {
  it('will not retire a stage that holds a deal, live or in the Recycle Bin', async () => {
    await refused(
      `update pipeline_stages set archived_at = now() where id = $1`,
      [first.stageIds[1]],
      'pipeline_stages_empty_before_retire',
    );

    await pool.query(`update deals set deleted_at = now() where id = $1`, [dealInProposal]);
    await refused(
      `update pipeline_stages set archived_at = now() where id = $1`,
      [first.stageIds[1]],
      'pipeline_stages_empty_before_retire',
    );
  });

  it('retires an empty stage, and then will not put a deal in it', async () => {
    await pool.query(`update pipeline_stages set archived_at = now() where id = $1`, [
      first.stageIds[0],
    ]);

    await refused(
      `insert into deals (id, tenant_id, name, pipeline_id, stage_id, probability)
       values (gen_random_uuid(), $1, 'Late', $2, $3, 10)`,
      [first.tenantId, first.pipelineId, first.stageIds[0]],
      'deals_stage_active',
    );

    const other = await fixtures.createDeal(first.tenantId, {
      pipelineId: first.pipelineId,
      stageId: first.stageIds[1]!,
      probability: 50,
    });
    await refused(
      `update deals set stage_id = $2, probability = 10 where id = $1`,
      [other, first.stageIds[0]],
      'deals_stage_active',
    );
  });

  it('still lets a deal be edited where it is, and still enforces the closed-state rule', async () => {
    const live = await fixtures.createDeal(first.tenantId, {
      pipelineId: first.pipelineId,
      stageId: first.stageIds[1]!,
      probability: 50,
    });
    await pool.query(`update deals set name = 'Renamed' where id = $1`, [live]);
    await pool.query(`update deals set probability = 60 where id = $1`, [live]);
    await refused(
      `update deals set stage_id = $2 where id = $1`,
      [live, first.stageIds[2]],
      'deals_stage_state',
    );
  });

  it('will not put two stages in use in one position, or under one name ignoring case', async () => {
    await refused(
      `update pipeline_stages set position = (select position from pipeline_stages where id = $2)
        where id = $1`,
      [first.stageIds[2], first.stageIds[3]],
      'pipeline_stages_active_position_key',
    );
    await refused(
      `update pipeline_stages set name = 'LOST' where id = $1`,
      [first.stageIds[2]],
      'pipeline_stages_active_name_key',
    );
  });

  it('lets a retired stage give up its name and its position', async () => {
    // `New` was retired above, so its name and position are free again.
    await pool.query(
      `insert into pipeline_stages (id, tenant_id, pipeline_id, name, position, probability, stage_type)
       select gen_random_uuid(), tenant_id, pipeline_id, 'new', position, 10, 'open'
         from pipeline_stages where id = $1`,
      [first.stageIds[0]],
    );
    const rows = await pool.query(
      `select 1 from pipeline_stages where pipeline_id = $1 and lower(name) = 'new'`,
      [first.pipelineId],
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('still freezes the type of a stage that holds deals', async () => {
    await refused(
      `update pipeline_stages set stage_type = 'won', probability = 100 where id = $1`,
      [first.stageIds[1]],
      'pipeline_stages_type_stable',
    );
  });

  it('refuses a retired-by with no retired-at, and a version of zero', async () => {
    await refused(
      `update pipeline_stages set archived_by = gen_random_uuid() where id = $1`,
      [second.stageIds[0]],
      'pipeline_stages_archived_chk',
    );
    await refused(
      `update pipeline_stages set version = 0 where id = $1`,
      [second.stageIds[0]],
      'pipeline_stages_version_chk',
    );
  });
});
