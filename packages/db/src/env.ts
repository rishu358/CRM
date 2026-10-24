import { loadEnv, type EnvFor, type EnvSource } from '@crm/env';

/**
 * Configuration for the CLI entry points in this package: migrate, seed, reindex (CLAUDE.md §5.8,
 * ADR-0044). The variables are declared once, in `@crm/env`'s registry, under the `db` scope; this
 * package reads no `process.env` itself. Validated once at startup so a misconfigured deployment
 * fails immediately and loudly rather than at the first query.
 *
 * - `DATABASE_URL`           the API's role (`crm_app`): no BYPASSRLS, owns nothing
 * - `DATABASE_MIGRATION_URL` `crm_migrator`, which owns the schema
 * - `DATABASE_AUTH_URL`      `crm_auth`: identity tables only
 * - `DATABASE_WORKER_URL`    `crm_worker`: the outbox relay
 */
export type DbEnv = EnvFor<'db'>;

export function loadDbEnv(source?: EnvSource): DbEnv {
  return loadEnv('db', source);
}

/**
 * Load-test tooling only (`src/perf`): a superuser connection to a **scratch** database, which the
 * seed refuses to use unless its name says it is one. Registered under its own `perf` scope, apart
 * from every application's, so no service can ever be configured with a superuser URL.
 */
export function loadPerfEnv(source?: EnvSource): { adminUrl: string | undefined } {
  return { adminUrl: loadEnv('perf', source).PERF_ADMIN_URL };
}
