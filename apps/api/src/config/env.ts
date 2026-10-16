import { z } from 'zod';

/**
 * The only module allowed to read process.env (CLAUDE.md §5.8).
 *
 * Validated once at boot so a missing secret stops the process immediately
 * rather than surfacing as a confusing 500 on the first request that needs it.
 * Errors report which variable is wrong, never its value.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    API_HOST: z.string().default('0.0.0.0'),
    WEB_URL: z.string().default('http://localhost:3000'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1),
    DATABASE_AUTH_URL: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

    REDIS_URL: z.string().optional(),

    // 32 bytes minimum. Short secrets are the usual way session signing fails
    // quietly, so this is a hard floor rather than a warning.
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    SESSION_COOKIE_NAME: z.string().default('crm_session'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(14),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX_PER_USER: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_MAX_PER_TENANT: z.coerce.number().int().positive().default(3000),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  })
  .passthrough();

export type ApiEnv = z.infer<typeof envSchema>;

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid API environment: ${problems}`);
  }
  return parsed.data;
}

export function corsOrigins(env: ApiEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** DI token for the validated environment. */
export const API_ENV_TOKEN = 'API_ENV';
