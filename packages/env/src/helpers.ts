import { z } from 'zod';
import type { GroupId, Requirement, Scope, VarDef, VarMeta } from './types.js';

/**
 * Builders for registry entries. Each returns the documentation and the schema together, so a
 * variable's default, its type and what the generated docs say about both come from one place.
 *
 * Every builder follows two rules that the loader relies on:
 *   * an empty string is "not set" (platforms and compose files pass `FOO=` for an unset variable;
 *     the loader drops those before validation, so nothing here handles `''`);
 *   * a secret's value never appears in a message (the loader replaces zod's text for secrets).
 */

type ScopeDefaults<T> = Partial<Record<Scope, T>>;

interface BaseMeta<Sc extends readonly Scope[]> {
  readonly scopes: Sc;
  readonly group: GroupId;
  readonly description: string;
  readonly secret?: boolean;
  /** Overrides the requirement the builder infers (only `production` is ever worth saying). */
  readonly requirement?: Requirement;
  readonly obtain?: string;
  readonly local?: string;
  readonly example?: string;
  readonly note?: string;
}

function meta<Sc extends readonly Scope[]>(m: BaseMeta<Sc>, inferred: Requirement): VarMeta {
  return {
    group: m.group,
    description: m.description,
    secret: m.secret ?? false,
    requirement: m.requirement ?? inferred,
    ...(m.obtain === undefined ? {} : { obtain: m.obtain }),
    ...(m.local === undefined ? {} : { local: m.local }),
    ...(m.example === undefined ? {} : { example: m.example }),
    ...(m.note === undefined ? {} : { note: m.note }),
  };
}

function pick<T>(
  scope: Scope,
  fallback: T | undefined,
  perScope?: ScopeDefaults<T>,
): T | undefined {
  return perScope?.[scope] ?? fallback;
}

// ---- strings ------------------------------------------------------------------------------------

interface TextOptions {
  readonly min?: number;
  readonly message?: string;
}

/** A string that must be set. */
export function requiredText<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: TextOptions = {},
): VarDef<string, false, Sc> {
  return {
    ...meta(m, 'required'),
    scopes: m.scopes,
    optional: false,
    schemaFor: () => (o.min === undefined ? z.string() : z.string().min(o.min, o.message)),
    defaultFor: () => undefined,
  };
}

/** A string with a default. */
export function defaultedText<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: { readonly default: string; readonly scopeDefaults?: ScopeDefaults<string> } & TextOptions,
): VarDef<string, false, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: false,
    schemaFor: (scope) => {
      const base = o.min === undefined ? z.string() : z.string().min(o.min, o.message);
      return base.default(pick(scope, o.default, o.scopeDefaults) ?? o.default);
    },
    defaultFor: (scope) => pick(scope, o.default, o.scopeDefaults),
  };
}

/** A string that may be left unset. */
export function optionalText<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: TextOptions = {},
): VarDef<string, true, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: true,
    schemaFor: () =>
      (o.min === undefined ? z.string() : z.string().min(o.min, o.message)).optional(),
    defaultFor: () => undefined,
  };
}

// ---- URLs ---------------------------------------------------------------------------------------

/** A URL with a default. */
export function defaultedUrl<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: { readonly default: string },
): VarDef<string, false, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: false,
    schemaFor: () => z.string().url().default(o.default),
    defaultFor: () => o.default,
  };
}

/** A URL that may be left unset. */
export function optionalUrl<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
): VarDef<string, true, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: true,
    schemaFor: () => z.string().url().optional(),
    defaultFor: () => undefined,
  };
}

// ---- numbers ------------------------------------------------------------------------------------

interface IntOptions {
  readonly default: number;
  readonly scopeDefaults?: ScopeDefaults<number>;
  /** `positive` is `> 0`; `nonnegative` is `>= 0`. */
  readonly sign: 'positive' | 'nonnegative';
  readonly max?: number;
}

/** An integer with a default. Read from text, so `"10"` is 10. */
export function defaultedInt<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: IntOptions,
): VarDef<number, false, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: false,
    schemaFor: (scope) => {
      const base = z.coerce.number().int();
      const signed = o.sign === 'positive' ? base.positive() : base.nonnegative();
      const bounded = o.max === undefined ? signed : signed.max(o.max);
      return bounded.default(pick(scope, o.default, o.scopeDefaults) ?? o.default);
    },
    defaultFor: (scope) => String(pick(scope, o.default, o.scopeDefaults) ?? o.default),
  };
}

// ---- choices and flags --------------------------------------------------------------------------

/** One of a fixed set, with a default. */
export function defaultedChoice<
  const Sc extends readonly Scope[],
  const V extends readonly [string, ...string[]],
>(
  m: BaseMeta<Sc>,
  o: { readonly values: V; readonly default: V[number] },
): VarDef<V[number], false, Sc> {
  return {
    ...meta(m, 'optional'),
    values: o.values,
    scopes: m.scopes,
    optional: false,
    schemaFor: () => z.enum(o.values).default(o.default),
    defaultFor: () => o.default,
  };
}

/** `"true"` or `"false"`, loaded as a boolean. Anything else is refused. */
export function defaultedFlag<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: { readonly default: boolean },
): VarDef<boolean, false, Sc> {
  return {
    ...meta(m, 'optional'),
    values: ['true', 'false'],
    scopes: m.scopes,
    optional: false,
    schemaFor: () =>
      z
        .enum(['true', 'false'])
        .default(o.default ? 'true' : 'false')
        .transform((value) => value === 'true'),
    defaultFor: () => (o.default ? 'true' : 'false'),
  };
}

// ---- checked values -----------------------------------------------------------------------------

/** A string with a default that must also pass a check (a valid time zone, a currency code). */
export function defaultedChecked<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
  o: {
    readonly default: string;
    readonly check: (value: string) => boolean;
    readonly message: string;
  },
): VarDef<string, false, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: false,
    schemaFor: () => z.string().refine(o.check, o.message).default(o.default),
    defaultFor: () => o.default,
  };
}

/** An email address that may be left unset. */
export function optionalEmail<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
): VarDef<string, true, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: true,
    schemaFor: () => z.email().optional(),
    defaultFor: () => undefined,
  };
}

/** A `#rrggbb` colour that may be left unset. Whether it is readable is checked where it is used. */
export function optionalHexColor<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
): VarDef<string, true, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: true,
    schemaFor: () =>
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour written #rrggbb')
        .optional(),
    defaultFor: () => undefined,
  };
}

/**
 * An address a browser loads an image from: an absolute http(s) URL, or a path on the web app's own
 * origin (`/brand/logo.svg`, served from `apps/web/public`). Never `javascript:`, `data:` or a
 * protocol-relative `//host`, which would let a typo become a script or an unexpected host.
 */
export function isAssetUrl(value: string): boolean {
  if (/^\/[^/\\]/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** An image address (see `isAssetUrl`) that may be left unset. */
export function optionalAssetUrl<const Sc extends readonly Scope[]>(
  m: BaseMeta<Sc>,
): VarDef<string, true, Sc> {
  return {
    ...meta(m, 'optional'),
    scopes: m.scopes,
    optional: true,
    schemaFor: () =>
      z.string().refine(isAssetUrl, 'must be an http(s) URL or a path starting with /').optional(),
    defaultFor: () => undefined,
  };
}
