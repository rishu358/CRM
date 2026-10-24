import { EnvError, loadEnv, type EnvFor, type EnvSource } from '@crm/env';
import { brandProblems } from './brand';

/**
 * The web app's environment, validated: the registry's rules (`@crm/env`, scope `web`) and the one
 * rule only this app can apply, that a configured brand colour is readable in its themes.
 *
 * Separate from `env.ts`, which is `server-only` and cached, so it can be exercised in a unit test.
 * Throws `EnvError` listing every problem at once, and never repeats a secret.
 */
export type WebEnv = EnvFor<'web'>;

export function loadWebEnv(source?: EnvSource): WebEnv {
  const env = loadEnv('web', source);
  const problems = brandProblems(env);
  if (problems.length > 0) throw new EnvError('web', problems);
  return env;
}
