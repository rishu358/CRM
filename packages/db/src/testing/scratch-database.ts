import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../migrator.js';
import { packageRootFrom } from '../package-root.js';
import { closePool } from '../pool-close.js';
import type { TestDbUrls } from './global-setup.js';

const packageRoot = packageRootFrom(import.meta.url);

/**
 * A database of its own, inside the same container, for a test whose subject is
 * the whole cluster rather than one company.
 *
 * Almost every test here shares one database and keeps to its own tenants,
 * which row-level security makes safe and which keeps the suite quick. A test
 * of something that is *defined* as "every company" cannot do that: it would
 * read, and rewrite, whatever the files running beside it happen to have
 * created. That is unsound in both directions — the other files' data changes
 * underneath them, and this test's work grows with theirs, which is how
 * rebuilding two companies' indexes turned into rebuilding a perf fixture's
 * hundred thousand records and timing out.
 *
 * So those tests get their own database, where "every company" means the
 * companies they made. The roles are cluster-wide and already exist; extensions
 * and grants are per-database, so the same bootstrap file production uses runs
 * here too, and then the migrations.
 */
export interface ScratchDatabase {
  /** The same roles as the shared test database, pointed at this one. */
  readonly urls: TestDbUrls;
  /** Closes the admin connection and drops the database. */
  drop(): Promise<void>;
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * `name` becomes a database name, so it is spliced into SQL that cannot take a
 * parameter. Tests pass a literal; this makes sure it stays one.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,48}$/;

export async function createScratchDatabase(
  urls: TestDbUrls,
  name: string,
): Promise<ScratchDatabase> {
  if (!NAME_PATTERN.test(name)) {
    throw new TypeError(`Not a usable scratch database name: ${name}`);
  }

  const admin = new pg.Pool({ connectionString: urls.superuser, max: 1 });
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);

  const scoped: TestDbUrls = {
    app: urlFor(urls.app, name),
    auth: urlFor(urls.auth, name),
    worker: urlFor(urls.worker, name),
    erasure: urlFor(urls.erasure, name),
    migrator: urlFor(urls.migrator, name),
    superuser: urlFor(urls.superuser, name),
  };

  const bootstrap = new pg.Pool({ connectionString: scoped.superuser, max: 1 });
  try {
    await bootstrap.query(
      await readFile(join(packageRoot, 'sql', 'bootstrap', '01-extensions-and-roles.sql'), 'utf8'),
    );
  } finally {
    await closePool(bootstrap);
  }

  await runMigrations(scoped.migrator, join(packageRoot, 'migrations'));

  return {
    urls: scoped,
    drop: async () => {
      // Deliberately not `with (force)`. Forcing terminates whatever is still
      // connected, which both hides a pool the test forgot to close and raises
      // a FATAL on the connection it kills; failing here names the bug instead.
      await admin.query(`drop database if exists ${name}`);
      await closePool(admin);
    },
  };
}
