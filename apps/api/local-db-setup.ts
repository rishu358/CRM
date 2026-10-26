// LOCAL ONLY, never committed: runs the API suites against a throwaway database on the already-running
// compose Postgres instead of starting a second container (this laptop has too little memory for that).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations } from '@crm/db';
import type { TestProject } from 'vitest/node';

const DB = process.env['LOCAL_TEST_DB'] ?? 'crm_views_test';
const HOST = 'localhost:15432';
const PASSWORDS: Record<string, string> = {
  crm_app: 'crm_app_dev',
  crm_auth: 'crm_auth_dev',
  crm_worker: 'crm_worker_dev',
  crm_erasure: 'crm_erasure_dev',
  crm_migrator: 'crm_migrator_dev',
};
const url = (user: string, password: string, db = DB) =>
  `postgres://${user}:${password}@${HOST}/${db}`;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (DB === 'crm') throw new Error('Refusing to touch the dev database');
  const root = new pg.Client({ connectionString: url('postgres', 'postgres', 'postgres') });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${DB}`);

  const bootstrap = await readFile(
    join(process.cwd(), '..', '..', 'packages', 'db', 'sql', 'bootstrap', '01-extensions-and-roles.sql'),
    'utf8',
  );
  const inDb = new pg.Client({ connectionString: url('postgres', 'postgres') });
  await inDb.connect();
  await inDb.query(bootstrap);
  await inDb.end();

  const migrator = url('crm_migrator', PASSWORDS['crm_migrator']!);
  await runMigrations(migrator, join(process.cwd(), '..', '..', 'packages', 'db', 'migrations'));

  project.provide('dbUrls', {
    app: url('crm_app', PASSWORDS['crm_app']!),
    auth: url('crm_auth', PASSWORDS['crm_auth']!),
    worker: url('crm_worker', PASSWORDS['crm_worker']!),
    erasure: url('crm_erasure', PASSWORDS['crm_erasure']!),
    migrator,
    superuser: url('postgres', 'postgres'),
  });

  return async () => {
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await root.end();
  };
}
