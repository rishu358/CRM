import { join } from 'node:path';
import { loadDbEnv } from './env.js';
import { packageRootFrom } from './package-root.js';
import { loadRootEnvFile } from './load-env.js';
import { runMigrations } from './migrator.js';

/** CLI entry point: `pnpm db:migrate`. */

const migrationsDir = join(packageRootFrom(import.meta.url), 'migrations');

loadRootEnvFile();
const env = loadDbEnv();
const connectionString = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;

const result = await runMigrations(connectionString, migrationsDir, env.DATABASE_CA_CERT);

if (result.applied.length === 0) {
  console.warn(`No new migrations. ${result.skipped.length} already applied.`);
} else {
  console.warn(`Applied ${result.applied.length} migration(s):`);
  for (const filename of result.applied) console.warn(`  ${filename}`);
}
