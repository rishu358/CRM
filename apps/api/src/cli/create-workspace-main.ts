import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { AuthService } from '../auth/auth.service.js';
import { loadApiEnv, type ApiEnv } from '../config/env.js';
import { runCreateWorkspace } from './create-workspace.js';
import { promptHidden, readLineFrom } from './password-input.js';

/**
 * `pnpm tenant:create`, or `node dist/cli/create-workspace-main.js` in a deployed image (ADR-0046).
 *
 * Runs with the API's own configuration and the API's own database roles: it needs no credential the
 * API does not already hold, and in production the same start-up checks apply (a role that bypasses
 * row-level security is refused). The application is only started once the command line has been
 * understood and a password obtained, so `--help` and a typo work on a machine with no environment.
 */
let app: INestApplicationContext | undefined;
let env: ApiEnv | undefined;

async function boot(): Promise<INestApplicationContext> {
  if (app === undefined) {
    env = loadApiEnv();
    app = await NestFactory.createApplicationContext(AppModule.forRoot(env), { logger: false });
  }
  return app;
}

/** Ask twice on a terminal; or take one line from a pipe when `--password-stdin` was given. */
async function askPassword(fromStdin: boolean): Promise<string | null> {
  if (fromStdin) return readLineFrom(process.stdin);

  if (!process.stdin.isTTY) {
    console.error(
      'Standard input is not a terminal, so the password cannot be prompted for. Pipe it in and add --password-stdin.',
    );
    return null;
  }
  const write = (text: string) => void process.stdout.write(text);
  const first = await promptHidden('Owner password: ', process.stdin, write);
  if (first === null) return null;
  const second = await promptHidden('Repeat the password: ', process.stdin, write);
  if (second === null) return null;
  if (first !== second) {
    console.error('The two passwords differ. Nothing was created.');
    return null;
  }
  return first;
}

// `pnpm run tenant:create -- --flag` forwards the `--`; it is not an argument of ours.
const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));

const code = await runCreateWorkspace({
  argv,
  auth: {
    async createWorkspaceForOperator(input) {
      const context = await boot();
      return context.get(AuthService, { strict: false }).createWorkspaceForOperator(input);
    },
  },
  webUrl: () => env?.WEB_URL ?? '',
  password: askPassword,
  print: (line) => console.warn(line),
  printError: (line) => console.error(line),
});

await app?.close();
process.exit(code);
