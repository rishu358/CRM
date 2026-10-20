import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../migrator.js';

/**
 * One real Postgres for the whole test run (CLAUDE.md §10).
 *
 * Permission and isolation tests must run against a real database with RLS
 * enabled. A mocked database would happily confirm whatever the test expects
 * and prove nothing about the property we actually care about.
 *
 * The container is bootstrapped exactly like production: roles created by a
 * superuser, schema created by crm_migrator, and the tests then connect as the
 * unprivileged roles the application uses.
 */

import { packageRootFrom } from '../package-root.js';

const packageRoot = packageRootFrom(import.meta.url);

export interface TestDbUrls {
  readonly app: string;
  readonly auth: string;
  readonly worker: string;
  /** The narrow audit-redaction role (ADR-0032). Used by the erasure job only. */
  readonly erasure: string;
  readonly migrator: string;
  readonly superuser: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    dbUrls: TestDbUrls;
  }
}

const DEV_PASSWORDS: Readonly<Record<string, string>> = {
  crm_app: 'crm_app_dev',
  crm_auth: 'crm_auth_dev',
  crm_worker: 'crm_worker_dev',
  crm_erasure: 'crm_erasure_dev',
  crm_migrator: 'crm_migrator_dev',
};

function urlForRole(base: URL, role: string): string {
  const url = new URL(base.toString());
  url.username = role;
  url.password = DEV_PASSWORDS[role] ?? '';
  return url.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16.6-alpine')
    .withDatabase('crm_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const superuserUrl = new URL(container.getConnectionUri());

  // Bootstrap: extensions and roles, as a superuser. Same file production uses.
  const bootstrapSql = await readFile(
    join(packageRoot, 'sql', 'bootstrap', '01-extensions-and-roles.sql'),
    'utf8',
  );
  const bootstrapClient = new pg.Client({ connectionString: superuserUrl.toString() });
  await bootstrapClient.connect();
  try {
    await bootstrapClient.query(bootstrapSql);
  } finally {
    await bootstrapClient.end();
  }

  const migratorUrl = urlForRole(superuserUrl, 'crm_migrator');
  await runMigrations(migratorUrl, join(packageRoot, 'migrations'));

  project.provide('dbUrls', {
    app: urlForRole(superuserUrl, 'crm_app'),
    auth: urlForRole(superuserUrl, 'crm_auth'),
    worker: urlForRole(superuserUrl, 'crm_worker'),
    erasure: urlForRole(superuserUrl, 'crm_erasure'),
    migrator: migratorUrl,
    superuser: superuserUrl.toString(),
  });

  return async () => {
    await container.stop();
  };
}
