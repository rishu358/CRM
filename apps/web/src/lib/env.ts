import 'server-only';
import { loadEnv, type EnvFor } from '@crm/env';

/**
 * Server-side configuration for the web app (CLAUDE.md §5.8, ADR-0044).
 *
 * `server-only` makes an accidental import from a client component a build error rather than a
 * runtime surprise: these values must never be bundled into the browser.
 *
 * The web app is registered for five variables and no more (`API_URL`, `S3_PUBLIC_ENDPOINT`, the
 * two session settings it shares with the API, and the environment names). It runs on a different
 * platform from the database and must hold no credential, and `loadEnv('web')` enforces that
 * rather than trusting whoever fills in the project settings: outside local development it refuses
 * to start if it is handed a database URL, `AUTH_SECRET` or any other secret meant for another
 * process.
 */
export type WebEnv = EnvFor<'web'>;

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  cached ??= loadEnv('web');
  return cached;
}
