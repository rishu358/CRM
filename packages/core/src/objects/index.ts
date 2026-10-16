/**
 * The object-type registry (ADR-0005).
 *
 * Polymorphic links store `(object_type, record_id)`, so `object_type` arrives
 * from the client on activities, tags, attachments and timeline queries. It is
 * therefore untrusted input that reaches a table name, and must be validated
 * against this closed set before it is used anywhere near SQL (CLAUDE.md §5.7).
 *
 * P2 adds custom objects. At that point this list gains a dynamic tail sourced
 * from tenant metadata; the validation boundary stays exactly here.
 */

export const OBJECT_TYPES = ['account', 'contact', 'lead', 'deal', 'activity'] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

const OBJECT_TYPE_SET: ReadonlySet<string> = new Set(OBJECT_TYPES);

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === 'string' && OBJECT_TYPE_SET.has(value);
}

/** Validate untrusted input into an ObjectType, or throw. */
export function toObjectType(value: unknown): ObjectType {
  if (!isObjectType(value)) {
    throw new TypeError(`Unknown object type: ${String(value)}`);
  }
  return value;
}

/** Object types that hold business records with owners and soft deletes. */
export const BUSINESS_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal'] as const;
export type BusinessObjectType = (typeof BUSINESS_OBJECT_TYPES)[number];

const BUSINESS_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(BUSINESS_OBJECT_TYPES);

export function isBusinessObjectType(value: unknown): value is BusinessObjectType {
  return typeof value === 'string' && BUSINESS_OBJECT_TYPE_SET.has(value);
}

/** The actions a role may be granted on an object type. */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'import'] as const;
export type Action = (typeof ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTION_SET.has(value);
}

/**
 * How much of an object type a grant covers.
 *
 * Ordered least to most permissive; `scopeRank` makes "at least this much"
 * comparisons explicit rather than relying on string ordering.
 */
export const SCOPES = ['own', 'team', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_RANK: Readonly<Record<Scope, number>> = { own: 0, team: 1, all: 2 };

export function scopeRank(scope: Scope): number {
  return SCOPE_RANK[scope];
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && value in SCOPE_RANK;
}

/** The widest of two scopes. Used when a user holds several roles. */
export function widestScope(a: Scope, b: Scope): Scope {
  return scopeRank(a) >= scopeRank(b) ? a : b;
}
