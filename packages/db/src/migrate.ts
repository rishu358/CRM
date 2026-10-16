import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDbEnv } from './env.js';
import { runMigrations } from './migrator.js';

/** CLI entry point: `pnpm db:migrate`. */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const env = loadDbEnv();
const connectionString = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;

const result = await runMigrations(connectionString, migrationsDir);

if (result.applied.length === 0) {
  console.warn(`No new migrations. ${result.skipped.length} already applied.`);
} else {
  console.warn(`Applied ${result.applied.length} migration(s):`);
  for (const filename of result.applied) console.warn(`  ${filename}`);
}
