import { readFileSync } from 'node:fs';

/**
 * Tiny command-line reader: `--name value` pairs and bare `--flag`s. Nothing here reads process.env;
 * connection details come in as arguments or from the env file the person names (CLAUDE.md 13.2).
 */
export function parseArgs(argv, defaults = {}) {
  const result = { ...defaults, _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `pnpm pilot:run -- --flag` forwards the bare `--`; it is not an argument of ours.
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result[name] = true;
    } else {
      result[name] = next;
      index += 1;
    }
  }
  return result;
}

/** Reads KEY=value lines of an env file (no shell, no expansion). */
export function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/**
 * The simulation drives a throwaway database and must never be pointed at anything else. Every
 * database URL in the env file has to end in /crm_pilot, or the command stops before doing anything.
 */
export function assertPilotDatabase(envValues) {
  const names = [
    'DATABASE_URL',
    'DATABASE_AUTH_URL',
    'DATABASE_WORKER_URL',
    'DATABASE_ERASURE_URL',
    'DATABASE_MIGRATION_URL',
  ];
  for (const name of names) {
    const value = envValues[name];
    if (value === undefined) continue;
    if (!/\/crm_pilot(\?.*)?$/.test(value)) {
      throw new Error(`${name} does not point at the database crm_pilot. Refusing to continue.`);
    }
  }
  if (envValues.DATABASE_URL === undefined)
    throw new Error('DATABASE_URL is missing from the env file');
}
