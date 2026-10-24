import type { z } from 'zod';

/**
 * Who reads a variable. A variable is only validated, typed and documented for the scopes it lists,
 * so the web app can never be handed (or silently accept) a database credential.
 *
 *   api, worker, web  the three long-running processes
 *   db                the CLI entry points in packages/db (migrate, seed, reindex)
 *   perf              the load-test tooling (never run in production)
 *
 * The release variables docker-compose reads (`CRM_VERSION`, `APP_HOST`, ...) are not application
 * configuration and are not here; the generator writes them as a fixed block.
 */
export const SCOPES = ['api', 'worker', 'web', 'db', 'perf'] as const;
export type Scope = (typeof SCOPES)[number];

export const LOADABLE_SCOPES = SCOPES;
export type LoadableScope = Scope;

/** Sections of the generated documentation and example files, in reading order. */
export const GROUPS = [
  { id: 'runtime', title: 'Runtime', blurb: 'Which environment this is, and how loud it is.' },
  {
    id: 'addresses',
    title: 'Addresses',
    blurb: 'Where each process listens and where the others find it.',
  },
  {
    id: 'database',
    title: 'Database',
    blurb: 'One PostgreSQL role per job. Never a superuser, never the same password twice.',
  },
  {
    id: 'auth',
    title: 'Sessions and authentication',
    blurb: 'Signing, cookies and sign-in limits.',
  },
  { id: 'limits', title: 'Rate limits', blurb: 'Per user, per tenant and per address.' },
  { id: 'email', title: 'Email', blurb: 'Outgoing mail.' },
  { id: 'storage', title: 'Object storage', blurb: 'Uploaded files, imports and exports.' },
  { id: 'cache', title: 'Redis', blurb: 'Shared counters (optional today).' },
  { id: 'oauth', title: 'Sign in with Google', blurb: 'Optional; off unless both halves are set.' },
  { id: 'worker', title: 'Worker', blurb: 'Background processing.' },
  {
    id: 'tooling',
    title: 'Tooling',
    blurb: 'Load tests and end-to-end runs. Never in production.',
  },
] as const;
export type GroupId = (typeof GROUPS)[number]['id'];

/**
 * `required`    the process refuses to start without it
 * `production`  optional to start, but a production process refuses to run without a real value
 *               (`packages/core/src/config/production.ts`)
 * `optional`    safe to leave unset
 */
export type Requirement = 'required' | 'production' | 'optional';

export interface VarMeta {
  readonly group: GroupId;
  /** For a variable with a fixed set of values, the values (shown in the generated docs). */
  readonly values?: readonly string[];
  readonly description: string;
  /** True for anything that must never reach a log, an error message, a repository or the web app. */
  readonly secret: boolean;
  readonly requirement: Requirement;
  /** Where to get a real value: who issues it, or the command that generates it. */
  readonly obtain?: string;
  /** The value written to the local `.env.example`; falls back to the default, then to blank. */
  readonly local?: string;
  /** The placeholder shown in the staging and production templates. */
  readonly example?: string;
  /** Anything else a person setting this needs to know (caveats, rotation, constraints). */
  readonly note?: string;
}

/**
 * One variable: its documentation and the schema that validates it, declared together so the two
 * cannot disagree. `T` is the type the loaded value has; `O` says whether the key may be absent from
 * the loaded object; `Sc` is the tuple of scopes that read it, kept literal so that the type of each
 * app's environment is computed from the registry rather than written out twice.
 */
export interface VarDef<T, O extends boolean, Sc extends readonly Scope[]> extends VarMeta {
  readonly scopes: Sc;
  /** Phantom: `true` means the loaded object may omit this key. Never read at run time. */
  readonly optional: O;
  /** `T | undefined`: an optional variable validates `undefined` as well as a `T`. */
  schemaFor(scope: Scope): z.ZodType<T | undefined>;
  /** The default for this scope, as text, or undefined if there is none. */
  defaultFor(scope: Scope): string | undefined;
}

export type AnyVarDef = VarDef<unknown, boolean, readonly Scope[]>;

/** Where values come from. Always passed in, so tests never touch the real process environment. */
export type EnvSource = Readonly<Record<string, string | undefined>>;
