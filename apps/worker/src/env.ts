import { storageEnvShape } from '@crm/storage';
import { z } from 'zod';

/** The only module in the worker that reads process.env (CLAUDE.md §5.8). */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Connects as crm_worker: tenant-scoped, plus cross-tenant outbox reads. */
    DATABASE_WORKER_URL: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(5),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
    /** Where a digest email points people back to. */
    WEB_URL: z.string().default('http://localhost:3000'),
    EMAIL_PROVIDER: z.enum(['console', 'memory']).default('console'),
    EMAIL_FROM: z.string().default('no-reply@localhost'),
    /**
     * How long after the first notification a digest goes out (ADR-0025).
     *
     * Short enough to be useful, long enough that a burst of assignments is
     * one email rather than five. Configurable because the right answer
     * differs between a demo and a live tenant.
     */
    DIGEST_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
    // Object storage for import files and generated exports (CLAUDE.md §5.12).
    ...storageEnvShape,
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  })
  .passthrough();

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid worker environment: ${problems}`);
  }
  return parsed.data;
}
