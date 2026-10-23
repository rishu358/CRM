import { z } from 'zod';

/**
 * The only place in this package that reads process.env (CLAUDE.md §5.8).
 * Validated once at startup so a misconfigured deployment fails immediately and
 * loudly rather than at the first query.
 */
const envSchema = z.object({
  /** The API connects as crm_app: no BYPASSRLS, owns nothing. */
  DATABASE_URL: z.string().min(1),
  /** Migrations connect as crm_migrator, which owns the schema. */
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  /** The auth layer connects as crm_auth: identity tables only. */
  DATABASE_AUTH_URL: z.string().min(1).optional(),
  /** The outbox relay connects as crm_worker. */
  DATABASE_WORKER_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  /** The managed provider's CA certificate: PEM, or base64 of it. See `tls.ts`. */
  DATABASE_CA_CERT: z.string().optional(),
});

export type DbEnv = z.infer<typeof envSchema>;

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Prints which variables are wrong, never their values.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid database environment: ${problems}`);
  }
  return parsed.data;
}

/**
 * Load-test tooling only (`src/perf`): a superuser connection to a **scratch** database, which
 * the seed refuses to use unless its name says it is one. Kept out of `DbEnv` so no service ever
 * sees, or can be configured with, a superuser URL.
 */
export function loadPerfEnv(source: NodeJS.ProcessEnv = process.env): {
  adminUrl: string | undefined;
} {
  const value = source['PERF_ADMIN_URL'];
  return { adminUrl: value === undefined || value === '' ? undefined : value };
}
