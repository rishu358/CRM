import 'server-only';
import { z } from 'zod';

/**
 * Server-side configuration for the web app (CLAUDE.md §5.8).
 *
 * The only module here allowed to read process.env. `server-only` makes an
 * accidental import from a client component a build error rather than a
 * runtime surprise — these values must never be bundled into the browser.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Where the versioned API lives. The proxy forwards here and nowhere else. */
    API_URL: z.string().url().default('http://localhost:3001'),
    SESSION_COOKIE_NAME: z.string().min(1).default('crm_session'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(14),
    /**
     * Where the browser uploads files, by presigned URL (CLAUDE.md §5.12). Only its origin is
     * used, and only to let the page connect to it: see `csp.ts`. Unset with in-memory storage.
     */
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  })
  .passthrough();

export type WebEnv = z.infer<typeof envSchema>;

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  if (cached !== undefined) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid web environment: ${problems}`);
  }

  cached = parsed.data;
  return cached;
}
