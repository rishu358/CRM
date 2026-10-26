import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { KeyRing } from '../auth/crypto/key-ring.js';
import { KeyRotationService } from '../auth/crypto/key-rotation.service.js';
import { loadApiEnv } from '../config/env.js';
import { runRotateKeys } from './rotate-keys.js';

/**
 * `pnpm auth:rotate-keys`, or `node dist/cli/rotate-keys-main.js` in a deployed image (ADR-0049).
 *
 * Runs with the API's own configuration and database roles; the rewrite goes through the auth role,
 * the only one that reads the table. The application is only started once the command line has been
 * understood, so `--help` and a typo work on a machine with no environment.
 */
let app: INestApplicationContext | undefined;

async function boot(): Promise<INestApplicationContext> {
  app ??= await NestFactory.createApplicationContext(AppModule.forRoot(loadApiEnv()), {
    logger: false,
  });
  return app;
}

// `pnpm run auth:rotate-keys -- --dry-run` forwards the `--`; it is not an argument of ours.
const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));

const code = await runRotateKeys({
  argv,
  async rotation() {
    return (await boot()).get(KeyRotationService, { strict: false });
  },
  currentKeyId: () => (app as INestApplicationContext).get(KeyRing, { strict: false }).currentId,
  print: (line) => console.warn(line),
  printError: (line) => console.error(line),
});

await app?.close();
process.exit(code);
