#!/usr/bin/env node
/**
 * `pnpm run setup`: from a fresh clone to a running local stack (ADR-0051).
 *
 * (`pnpm setup` without `run` is a pnpm built-in that configures pnpm itself, so the script is
 * run as `pnpm run setup`.)
 *
 * Zero dependencies, like the hooks and the commit check, so it runs before `pnpm install` has
 * produced anything to depend on. Every step is idempotent and says what it did or skipped, and the
 * script never prints a secret.
 *
 *   pnpm run setup              check the machine, create .env, start the services, migrate,
 *                               seed the demo workspace (first run only), build
 *   pnpm run setup -- --check   only check; change nothing; exit non-zero with a reason
 *   --no-seed                   do not create the demo workspace
 *   --seed                      create another demo workspace even if this is not the first run
 *   --minimal                   instead of the demo company, one empty workspace with one owner
 *   --no-build                  skip `pnpm build`
 *
 * All outside effects (files, commands, the clock's randomness, the output) are parameters of
 * `runSetup`, so `setup.test.mjs` exercises it without Docker, a database or a terminal.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MINIMUM_NODE = [24, 7, 0];

export const USAGE = `Set up a local development environment.

Usage:
  pnpm run setup [--check] [--no-seed | --seed | --minimal] [--no-build]

  --check      Check the machine and the configuration; change nothing.
  --no-seed    Do not create the demo workspace.
  --seed       Create a demo workspace even if this is not the first run.
  --minimal    Create one empty workspace with one owner (a generated password, shown once)
               instead of the demo company.
  --no-build   Skip the build.
  --help       Show this text.

First run: creates .env from .env.example (with a generated AUTH_SECRET), starts Postgres, Redis,
MinIO and a local mail inbox (Mailpit), applies the migrations, creates the demo workspace and builds.
Later runs leave .env and the demo data alone. "pnpm setup" without "run" is a built-in pnpm command,
not this.
`;

/** `AUTH_SECRET=` left empty or at the development placeholder from .env.example. */
const PLACEHOLDER_SECRET = /^AUTH_SECRET=(?:dev-only[^\r\n]*|CHANGE_ME[^\r\n]*)?[ \t]*$/m;

/** @param {string} version e.g. "24.11.1" */
export function nodeIsRecent(version) {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    const have = parts[index] ?? 0;
    const need = MINIMUM_NODE[index];
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/**
 * @param {string[]} argv
 * @returns {{ kind: 'help' } | { kind: 'error', message: string } | { kind: 'run', check: boolean, seed: 'auto' | 'yes' | 'no' | 'minimal', build: boolean }}
 */
export function parseArgs(argv) {
  let check = false;
  let seed = 'auto';
  let build = true;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (arg === '--check') check = true;
    else if (arg === '--no-seed') seed = 'no';
    else if (arg === '--seed') seed = 'yes';
    else if (arg === '--minimal') seed = 'minimal';
    else if (arg === '--no-build') build = false;
    else return { kind: 'error', message: `Unknown argument: ${arg}` };
  }
  return { kind: 'run', check, seed, build };
}

/**
 * @typedef {object} SetupDeps
 * @property {string[]} argv
 * @property {string} root                      The repository root.
 * @property {string} nodeVersion
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => string} read
 * @property {(path: string, text: string) => void} write   Written with owner-only permission.
 * @property {(command: string, args: string[]) => Promise<number>} run   Resolves to the exit code.
 * @property {(bytes: number) => Buffer} random
 * @property {(line: string) => void} print
 * @property {(line: string) => void} printError
 */

/**
 * @param {SetupDeps} deps
 * @returns {Promise<number>} 0 done, 1 a check or step failed, 2 the command line was wrong
 */
export async function runSetup(deps) {
  const args = parseArgs(deps.argv);
  if (args.kind === 'help') {
    deps.print(USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    deps.printError(`${args.message}\n\n${USAGE}`);
    return 2;
  }

  const say = (line) => deps.print(line);
  const envPath = resolve(deps.root, '.env');
  const examplePath = resolve(deps.root, '.env.example');

  // ---- 1. The machine ------------------------------------------------------------------------
  const problems = [];

  if (nodeIsRecent(deps.nodeVersion)) {
    say(`ok       Node ${deps.nodeVersion}`);
  } else {
    problems.push(
      `Node ${deps.nodeVersion} is too old: Node ${MINIMUM_NODE.join('.')} or later is required (password hashing uses its built-in Argon2id). Install a current Node 24.`,
    );
  }
  if ((await deps.run('pnpm', ['--version'])) === 0) {
    say('ok       pnpm');
  } else {
    problems.push(
      'pnpm was not found. Install it (https://pnpm.io/installation) and run this again.',
    );
  }
  if ((await deps.run('docker', ['info'])) === 0) {
    say('ok       Docker is running');
  } else {
    problems.push(
      'Docker is not reachable. Start Docker Desktop (or the Docker service) and run this again.',
    );
  }
  if (!deps.exists(examplePath)) {
    problems.push('.env.example is missing: run this from a complete checkout.');
  }

  if (problems.length > 0) {
    for (const problem of problems) deps.printError(`problem  ${problem}`);
    return 1;
  }

  // ---- 2. The configuration ------------------------------------------------------------------
  let createdEnv = false;
  if (deps.exists(envPath)) {
    say('skipped  .env already exists; left as it is');
    if (PLACEHOLDER_SECRET.test(deps.read(envPath))) {
      // Not replaced: AUTH_SECRET encrypts enrolled authenticators, so changing it under an existing
      // .env would make them unreadable (docs/SECRETS.md). Said, not done.
      say(
        'warning  AUTH_SECRET in .env is still the development placeholder. Fine locally; replace it (docs/SECRETS.md) before sharing this database.',
      );
    }
  } else if (args.check) {
    problems.push('.env does not exist yet; run `pnpm run setup` to create it.');
  } else {
    const secret = deps.random(48).toString('base64');
    const example = deps.read(examplePath);
    if (!PLACEHOLDER_SECRET.test(example)) {
      deps.printError(
        'problem  .env.example has no AUTH_SECRET placeholder to replace. Nothing was written.',
      );
      return 1;
    }
    // A function, so a `$` in the secret is never read as a replacement pattern.
    deps.write(
      envPath,
      example.replace(PLACEHOLDER_SECRET, () => `AUTH_SECRET=${secret}`),
    );
    createdEnv = true;
    say('created  .env from .env.example, with a generated AUTH_SECRET');
  }

  if (args.check) {
    if (problems.length > 0) {
      for (const problem of problems) deps.printError(`problem  ${problem}`);
      return 1;
    }
    say('\nNothing to fix. (This was a check; nothing was changed.)');
    return 0;
  }

  // ---- 3. The services, the schema, the demo data, the build ---------------------------------
  /** @param {string} label @param {string[]} command */
  const step = async (label, [command, ...rest]) => {
    say(`running  ${label}`);
    const code = await deps.run(command, rest);
    if (code !== 0) {
      deps.printError(
        `problem  "${[command, ...rest].join(' ')}" failed (exit ${String(code)}). Fix that, then run this again: every step is safe to repeat.`,
      );
      return false;
    }
    return true;
  };

  if (!(await step('pnpm infra:up  (Postgres, Redis, MinIO)', ['pnpm', 'infra:up']))) return 1;
  if (!(await step('pnpm db:migrate', ['pnpm', 'db:migrate']))) return 1;

  // The seed adds a demo workspace every time it runs, so it is not repeated by default.
  const seed =
    args.seed === 'yes' || args.seed === 'minimal' || (args.seed === 'auto' && createdEnv);
  if (seed) {
    const minimal = args.seed === 'minimal';
    const command = minimal ? ['pnpm', 'db:seed', '--minimal'] : ['pnpm', 'db:seed'];
    const label = minimal
      ? 'pnpm db:seed --minimal  (one empty workspace; prints the owner and a one-time password)'
      : 'pnpm db:seed  (demo workspace; prints the sign-in details)';
    if (!(await step(label, command))) return 1;
  } else {
    say(
      args.seed === 'no'
        ? 'skipped  demo workspace (--no-seed)'
        : 'skipped  demo workspace: this is not the first run. `pnpm db:seed` makes another.',
    );
  }

  if (args.build) {
    if (!(await step('pnpm build', ['pnpm', 'build']))) return 1;
  } else {
    say('skipped  build (--no-build)');
  }

  say(
    [
      '',
      'Ready. Start it with:  pnpm dev',
      '  web      http://localhost:3000',
      '  api      http://localhost:3001',
      '  files    http://localhost:19001  (MinIO console)',
      '  inbox    http://localhost:18025  (Mailpit: verification and reset emails arrive here)',
    ].join('\n'),
  );
  return 0;
}

// ---- the real world ----------------------------------------------------------------------------

/** Runs a command with the terminal attached. Resolves to its exit code, or 127 if it cannot start. */
function runInherit(command, args) {
  return new Promise((done) => {
    // `shell: true` so `pnpm` resolves to `pnpm.cmd` on Windows, with the command line joined into one
    // string (passing an argument array with a shell is deprecated). Every command and argument here is
    // a constant in this file: nothing a user typed reaches a shell.
    const child = spawn([command, ...args].join(' '), { stdio: 'inherit', shell: true });
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

/** `--version` and `info` are noise on a terminal; their exit code is the whole answer. */
function runQuiet(command, args) {
  return new Promise((done) => {
    const child = spawn([command, ...args].join(' '), { stdio: 'ignore', shell: true });
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // `pnpm run setup -- --check` forwards the `--`; it is not an argument of ours.
  const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  const code = await runSetup({
    argv,
    root,
    nodeVersion: process.versions.node,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    run: (command, args) =>
      args[0] === '--version' || command === 'docker'
        ? runQuiet(command, args)
        : runInherit(command, args),
    random: randomBytes,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
  process.exit(code);
}
