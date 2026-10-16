import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Migration runner.
 *
 * Migrations are **forward-only** (CLAUDE.md §7): applied files are recorded
 * with a checksum, and editing one after it has run is refused. Silently
 * re-running a changed file would leave every environment with a different
 * schema and no way to tell which.
 *
 * Runs as `crm_migrator`, which owns the schema. The API's role deliberately
 * cannot create or alter anything.
 */

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

function checksum(contents: string): string {
  // Normalise line endings so a Windows checkout and a Linux CI agree.
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

export async function runMigrations(
  connectionString: string,
  migrationsDir: string,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const entries = await readdir(migrationsDir);
    const files = entries.filter((name) => name.endsWith('.sql')).sort();

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.filename, row.checksum]));

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const filename of files) {
      const contents = await readFile(join(migrationsDir, filename), 'utf8');
      const hash = checksum(contents);
      const previous = alreadyApplied.get(filename);

      if (previous !== undefined) {
        if (previous !== hash) {
          throw new Error(
            `Migration ${filename} has changed since it was applied. ` +
              'Migrations are forward-only: write a new migration instead of editing this one.',
          );
        }
        skipped.push(filename);
        continue;
      }

      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(contents);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          hash,
        ]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${filename} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client.end();
  }
}
