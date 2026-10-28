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
 * Migration 0030 applied to a database that already has companies in it (ADR-0069).
 *
 * The right to import original dates is granted to Owner and Admin by this migration for every
 * company that exists, and by the seed for every company made after. The statement that does the
 * first runs against zero rows in every other test, so this builds the real situation: migrate to
 * just before 0030, create companies with their system roles, apply 0030, and look.
 */
const packageRoot = packageRootFrom(import.meta.url);
const MIGRATIONS = join(packageRoot, 'migrations');
const DATABASE = 'crm_backfill_0030';

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
  readonly managerRole: string;
  readonly repRole: string;
  readonly customRole: string;
}

async function company(name: string): Promise<Company> {
  const tenantId = (await fixtures.createTenant({ name })).tenantId;
  return {
    tenantId,
    ownerRole: await fixtures.createRole(tenantId, 'Owner', { isSystem: true }),
    adminRole: await fixtures.createRole(tenantId, 'Admin', { isSystem: true }),
    managerRole: await fixtures.createRole(tenantId, 'Manager', { isSystem: true }),
    repRole: await fixtures.createRole(tenantId, 'Sales Rep', { isSystem: true }),
    customRole: await fixtures.createRole(tenantId, 'Owner lookalike'),
  };
}

let first: Company;
let second: Company;

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

  beforeDir = mkdtempSync(join(tmpdir(), 'migrations-before-0030-'));
  throughDir = mkdtempSync(join(tmpdir(), 'migrations-through-0030-'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    if (file < '0030') cpSync(join(MIGRATIONS, file), join(beforeDir, file));
    if (file < '0031') cpSync(join(MIGRATIONS, file), join(throughDir, file));
  }
  const migratorUrl = urlFor(urls.migrator, DATABASE);
  await runMigrations(migratorUrl, beforeDir);

  fixtures = new Fixtures(pool);
  first = await company('Working for months');
  second = await company('Also working');

  const result = await runMigrations(migratorUrl, throughDir);
  expect(result.applied).toEqual(['0030_import_history_grant.sql']);
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
    `select action, scope from role_permissions where role_id = $1 and object_type = 'import_history'
      order by action`,
    [roleId],
  );
  return rows.rows.map((row) => `${row.action}:${row.scope}`);
}

describe('migration 0030 on a database that already has companies', () => {
  it('gives Owner and Admin of every existing company the right to import original dates', async () => {
    for (const company of [first, second]) {
      expect(await grantsOf(company.ownerRole), 'owner').toEqual(['create:all']);
      expect(await grantsOf(company.adminRole), 'admin').toEqual(['create:all']);
    }
  });

  it('gives nobody else anything: not a manager, not a rep, not a custom role that looks like the owner', async () => {
    for (const company of [first, second]) {
      expect(await grantsOf(company.managerRole)).toEqual([]);
      expect(await grantsOf(company.repRole)).toEqual([]);
      expect(await grantsOf(company.customRole)).toEqual([]);
    }
  });

  it('keeps every grant inside its own company', async () => {
    const strays = await pool.query(
      `select 1 from role_permissions p join roles r on r.id = p.role_id
        where p.object_type = 'import_history' and p.tenant_id <> r.tenant_id`,
    );
    expect(strays.rows).toHaveLength(0);
  });

  it('leaves no temporary policy behind on the permission tables', async () => {
    const left = await pool.query(
      `select policyname from pg_policies
        where tablename in ('role_permissions', 'roles') and policyname like '%f7_backfill'`,
    );
    expect(left.rows).toHaveLength(0);
  });
});
