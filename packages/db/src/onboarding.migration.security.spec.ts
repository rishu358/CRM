import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { Fixtures } from './testing/index.js';
import { packageRootFrom } from './package-root.js';

/**
 * Migration 0017 applied to a database that already has companies in it
 * (MVP_SPEC M2, ADR-0037).
 *
 * Every other test applies all migrations to an empty database, so the
 * statements in 0017 that exist for *existing* data — marking every company that
 * was already working as set up, and granting Owner and Admin the new right —
 * run there against zero rows and prove nothing. In production they run against
 * real ones, under the migration role, which is subject to row-level security
 * because the tables are FORCEd (that is why the migration opens and closes
 * temporary policies). This builds that situation: migrate to just before 0017,
 * create companies the way the older code did, then apply 0017 and look.
 */
const packageRoot = packageRootFrom(import.meta.url);
const MIGRATIONS = join(packageRoot, 'migrations');
const DATABASE = 'crm_backfill_0017';

let admin: pg.Pool;
let pool: pg.Pool;
let fixtures: Fixtures;
let beforeDir: string;
/** Everything up to and including 0017: later migrations are not this file's business. */
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
}

async function company(name: string): Promise<Company> {
  const tenantId = (await fixtures.createTenant({ name })).tenantId;
  return {
    tenantId,
    ownerRole: await fixtures.createRole(tenantId, 'Owner', { isSystem: true }),
    adminRole: await fixtures.createRole(tenantId, 'Admin', { isSystem: true }),
    repRole: await fixtures.createRole(tenantId, 'Sales Rep', { isSystem: true }),
    // A role somebody built themselves, which must get nothing.
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
  // Extensions and grants are per-database; roles already exist cluster-wide.
  await pool.query(
    readFileSync(join(packageRoot, 'sql', 'bootstrap', '01-extensions-and-roles.sql'), 'utf8'),
  );

  // Everything before 0017, in a folder of its own.
  beforeDir = mkdtempSync(join(tmpdir(), 'migrations-before-0017-'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    if (file < '0017') cpSync(join(MIGRATIONS, file), join(beforeDir, file));
  }

  throughDir = mkdtempSync(join(tmpdir(), 'migrations-through-0017-'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    if (file < '0018') cpSync(join(MIGRATIONS, file), join(throughDir, file));
  }

  const migratorUrl = urlFor(urls.migrator, DATABASE);
  await runMigrations(migratorUrl, beforeDir);

  // Companies as the code before this module made them: no setup column, no
  // `tenant_settings` grant, and an administrator who had been working for months.
  fixtures = new Fixtures(pool);
  first = await company('Working for months');
  second = await company('Also working');

  // Now the migration under test, on top of that.
  const result = await runMigrations(migratorUrl, throughDir);
  expect(result.applied).toEqual(['0017_onboarding.sql']);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${DATABASE} with (force)`);
  await admin.end();
  rmSync(beforeDir, { recursive: true, force: true });
  rmSync(throughDir, { recursive: true, force: true });
});

describe('migration 0017 on a database that already has companies', () => {
  it('marks every company that already existed as set up, so nobody meets a wizard', async () => {
    const rows = await pool.query<{ id: string; setup_completed_at: Date | null }>(
      `select id::text, setup_completed_at from tenants where id = any($1::uuid[])`,
      [[first.tenantId, second.tenantId]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row.setup_completed_at, row.id).not.toBeNull();
  });

  it('marks them complete as of when they were created, not as of the deployment', async () => {
    const result = await pool.query<{ matches: boolean }>(
      `select setup_completed_at = created_at as matches from tenants where id = $1`,
      [first.tenantId],
    );
    expect(result.rows[0]?.matches).toBe(true);
  });

  it('gives Owner and Admin the new right, read and update, at the only scope that means anything', async () => {
    for (const company of [first, second]) {
      for (const role of [company.ownerRole, company.adminRole]) {
        const grants = await pool.query<{ action: string; scope: string }>(
          `select action, scope from role_permissions
           where tenant_id = $1 and role_id = $2 and object_type = 'tenant_settings'
           order by action`,
          [company.tenantId, role],
        );
        expect(grants.rows, role).toEqual([
          { action: 'read', scope: 'all' },
          { action: 'update', scope: 'all' },
        ]);
      }
    }
  });

  it('gives nothing to a sales rep, or to a role somebody built themselves', async () => {
    for (const company of [first, second]) {
      for (const role of [company.repRole, company.customRole]) {
        const grants = await pool.query(
          `select 1 from role_permissions where tenant_id = $1 and role_id = $2 and object_type = 'tenant_settings'`,
          [company.tenantId, role],
        );
        expect(grants.rows, role).toHaveLength(0);
      }
    }
  });

  it("does not mix companies: one company's roles are not granted through another's", async () => {
    const stray = await pool.query(
      `select 1 from role_permissions p
       join roles r on r.id = p.role_id
       where p.object_type = 'tenant_settings' and p.tenant_id <> r.tenant_id`,
    );
    expect(stray.rows).toHaveLength(0);
  });

  it('leaves no temporary migration policy behind on any table it opened', async () => {
    const left = await pool.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where policyname like '%m2_backfill%'`,
    );
    expect(left.rows).toEqual([]);
  });

  it('leaves a company created afterwards needing setup, as a new one should', async () => {
    const created = await fixtures.createTenant({ name: 'Brand new' });
    const row = await pool.query<{ setup_completed_at: Date | null }>(
      `select setup_completed_at from tenants where id = $1`,
      [created.tenantId],
    );
    expect(row.rows[0]?.setup_completed_at).toBeNull();
  });

  it('applies exactly once: running the same migrations again changes nothing', async () => {
    const urls = inject('dbUrls');
    const again = await runMigrations(urlFor(urls.migrator, DATABASE), throughDir);
    expect(again.applied).toEqual([]);
  });
});
