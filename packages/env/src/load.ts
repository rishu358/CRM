import { z } from 'zod';
import { readProcessEnv } from './process-env.js';
import { REGISTRY, type Registry } from './registry.js';
import type { AnyVarDef, EnvSource, LoadableScope, Scope, VarDef } from './types.js';

// ---- the type of each scope's environment, computed from the registry ---------------------------

type InScope<K extends keyof Registry, S extends Scope> = S extends Registry[K]['scopes'][number]
  ? K
  : never;
type KeysIn<S extends Scope> = { [K in keyof Registry]: InScope<K, S> }[keyof Registry];
type Out<K extends keyof Registry> =
  Registry[K] extends VarDef<infer T, boolean, readonly Scope[]> ? T : never;
type IsOptional<K extends keyof Registry> = Registry[K]['optional'] extends true ? true : false;
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/**
 * What `loadEnv(scope)` returns: exactly the variables registered for that scope, typed from their
 * declarations. A variable that is not registered for the scope is not on the type, so code in the
 * web app cannot even name `DATABASE_URL`.
 */
export type EnvFor<S extends LoadableScope> = Flatten<
  { [K in KeysIn<S> as IsOptional<K> extends true ? never : K]: Out<K> } & {
    [K in KeysIn<S> as IsOptional<K> extends true ? K : never]?: Out<K> | undefined;
  }
>;

// ---- loading --------------------------------------------------------------------------------

const ENTRIES: readonly (readonly [string, AnyVarDef])[] = Object.entries(REGISTRY);

const LABEL: Record<LoadableScope, string> = {
  api: 'API',
  worker: 'worker',
  web: 'web',
  db: 'database',
  perf: 'load-test',
};

/** Every problem with an environment, by variable name. Never contains a secret's value. */
export class EnvError extends Error {
  constructor(
    readonly scope: LoadableScope,
    readonly problems: readonly string[],
  ) {
    super(`Invalid ${LABEL[scope]} environment: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

function definitionsFor(scope: Scope): readonly (readonly [string, AnyVarDef])[] {
  return ENTRIES.filter(([, def]) => def.scopes.includes(scope));
}

/**
 * The source as the schemas should see it:
 *   * a variable set to the empty string is not set (`FOO=` in an env file, an empty platform
 *     field, compose's `${FOO:-}`), so every "optional" variable really can be left blank;
 *   * `APP_ENV` is derived from `NODE_ENV` when absent, so existing deployments need no new variable.
 */
function normalise(source: EnvSource): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') input[name] = value;
  }
  input['APP_ENV'] ??= input['NODE_ENV'] === 'production' ? 'production' : 'local';
  return input;
}

/** A problem as text a person can act on, without ever repeating what they typed for a secret. */
function describeIssue(
  name: string,
  def: AnyVarDef | undefined,
  missing: boolean,
  message: string,
) {
  if (def === undefined) return message;
  if (missing) {
    return `${name} is not set${def.obtain === undefined ? '' : ` (get it: ${def.obtain})`}`;
  }
  // A secret's own text could quote the secret. Length limits are safe to state and are the
  // usual reason a secret is refused, so they keep their message; everything else is generic.
  if (def.secret && !/^(AUTH_SECRET must|Too (small|big))/.test(message)) {
    return `${name} is not valid`;
  }
  // A message that already names the variable ("AUTH_SECRET must be at least 32 characters") is not prefixed twice.
  return message.startsWith(name) ? message : `${name}: ${message}`;
}

/**
 * Secrets that are registered, but not for this scope, yet present in its environment.
 *
 * The web app runs on a different platform from the API, and the cheapest way a database password
 * reaches it is somebody pasting the whole `.env` into the project settings. Nothing in the web app
 * reads such a variable, so nothing would ever notice. This does: outside local development the
 * web app refuses to start while holding a secret it has no business with.
 */
function foreignSecrets(scope: LoadableScope, input: Record<string, string>): string[] {
  return ENTRIES.filter(
    ([name, def]) => def.secret && !def.scopes.includes(scope) && input[name] !== undefined,
  ).map(([name]) => name);
}

/**
 * Validate and type the environment for one scope. Throws `EnvError`, listing every problem at
 * once, so a bad deployment is fixed in one pass rather than one variable per restart.
 *
 * @param source defaults to the real process environment; tests pass their own, which is the only
 *   reason it is a parameter.
 */
export function loadEnv<S extends LoadableScope>(scope: S, source?: EnvSource): EnvFor<S> {
  const input = normalise(source ?? readProcessEnv());

  const shape: Record<string, z.ZodType> = {};
  for (const [name, def] of definitionsFor(scope)) shape[name] = def.schemaFor(scope);

  const parsed = z.object(shape).safeParse(input);
  if (!parsed.success) {
    const problems = new Set<string>();
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? '');
      const def = ENTRIES.find(([candidate]) => candidate === name)?.[1];
      problems.add(describeIssue(name, def, input[name] === undefined, issue.message));
    }
    throw new EnvError(scope, [...problems]);
  }

  if (scope === 'web' && input['APP_ENV'] !== 'local') {
    const foreign = foreignSecrets(scope, input);
    if (foreign.length > 0) {
      throw new EnvError(scope, [
        `${foreign.join(', ')} must not be set on the web app (APP_ENV=${String(input['APP_ENV'])}): it must never hold credentials meant for another process. On a local or CI run, set APP_ENV=local`,
      ]);
    }
  }

  // `shape` is built from the same registry entries that define `EnvFor<S>`, so the two agree by
  // construction; TypeScript cannot follow a runtime loop over a registry, hence one assertion here.
  return parsed.data as EnvFor<S>;
}

/**
 * The environment for a log line or a support ticket: every value for the scope, secrets replaced.
 * Use this, never the raw object, when a configuration has to be shown.
 */
export function redactedEnv(
  scope: LoadableScope,
  env: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, def] of definitionsFor(scope)) {
    const value = env[name];
    out[name] =
      value === undefined
        ? '(unset)'
        : def.secret
          ? '[redacted]'
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
  }
  return out;
}

/** The registry entries for a scope, for tooling that documents or inspects them. */
export function variablesFor(scope: Scope): readonly (readonly [string, AnyVarDef])[] {
  return definitionsFor(scope);
}

/** Every registered variable, in declaration order. */
export function allVariables(): readonly (readonly [string, AnyVarDef])[] {
  return ENTRIES;
}
