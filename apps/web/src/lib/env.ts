import 'server-only';
import { loadWebEnv, type WebEnv } from './load-env';

/**
 * Server-side configuration for the web app (CLAUDE.md §5.8, ADR-0044).
 *
 * `server-only` makes an accidental import from a client component a build error rather than a
 * runtime surprise: these values must never be bundled into the browser. The loading itself, and
 * its rules, are in `load-env.ts` so they can be tested.
 *
 * The web app is registered for a handful of variables and no more: `API_URL`, the object store's
 * public address, the two session settings it shares with the API, the environment names, and the
 * public branding (ADR-0045). It runs on a different platform from the database and must hold no
 * credential, and the loader enforces that rather than trusting whoever fills in the project
 * settings: outside local development it refuses to start if it is handed a database URL,
 * `AUTH_SECRET` or any other secret meant for another process.
 */
export type { WebEnv };

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}
