import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Load the repository-root `.env` for CLI entry points (migrate, seed).
 *
 * Only the CLIs call this. The API and worker get their configuration from the
 * process environment their deployment provides, and must never read a file
 * from the working directory — in production there is no .env to read, and
 * silently finding one would be worse than failing.
 *
 * Existing environment variables always win, so CI and container settings are
 * never overridden by a stray local file.
 */
export function loadRootEnvFile(): void {
  let directory = dirname(fileURLToPath(import.meta.url));
  const root = resolve('/');

  while (directory !== root) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate, override: false, quiet: true });
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
