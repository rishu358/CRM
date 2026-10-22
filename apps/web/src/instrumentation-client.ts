/**
 * Runs in the browser before the application's own code (Next's client instrumentation).
 *
 * Its one job is to switch Zod's code generation off before any schema exists: the
 * contracts build their schemas when their modules load, and the probe that decides
 * whether code generation is allowed runs as each is built. See `lib/zod-config.ts`.
 */
import './lib/zod-config';
