import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { loadApiEnv } from '../config/env.js';
import { EntitlementsOperator } from '../platform/entitlements-operator.service.js';
import { runEntitlementsCommand } from './entitlements-command.js';

/**
 * `pnpm tenant:entitlements`, or `node dist/cli/entitlements-main.js` in a deployed image (ADR-0047).
 *
 * Runs with the API's own configuration and database roles. The writes go through the auth role, the
 * only one that may change a plan or an override; no request path can. The application is only
 * started once the command line has been understood, so `--help`, `features` and a typo work on a
 * machine with no environment.
 */
let app: INestApplicationContext | undefined;

// `pnpm run tenant:entitlements -- show` forwards the `--`; it is not an argument of ours.
const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));

const code = await runEntitlementsCommand({
  argv,
  async operator() {
    app ??= await NestFactory.createApplicationContext(AppModule.forRoot(loadApiEnv()), {
      logger: false,
    });
    return app.get(EntitlementsOperator, { strict: false });
  },
  print: (line) => console.warn(line),
  printError: (line) => console.error(line),
});

await app?.close();
process.exit(code);
