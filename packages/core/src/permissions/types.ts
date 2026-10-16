import type { Uuid } from '../ids/index.js';
import type { Action, ObjectType, Scope } from '../objects/index.js';

/** How much of a field a role may see. Ordered least to most permissive. */
export const FIELD_ACCESS_LEVELS = ['hidden', 'read', 'write'] as const;
export type FieldAccess = (typeof FIELD_ACCESS_LEVELS)[number];

export const FIELD_ACCESS_RANK: Readonly<Record<FieldAccess, number>> = {
  hidden: 0,
  read: 1,
  write: 2,
};

/** A row of `role_permissions`. */
export interface RolePermissionRow {
  readonly roleId: Uuid;
  readonly objectType: ObjectType;
  readonly action: Action;
  readonly scope: Scope;
}

/** A row of `field_permissions`. Narrows a role within an object it can already reach. */
export interface FieldPermissionRow {
  readonly roleId: Uuid;
  readonly objectType: ObjectType;
  readonly fieldKey: string;
  readonly access: FieldAccess;
}

/**
 * A role's permissions, compiled for O(1) lookup.
 * Built once per request from the actor's roles; never mutated afterwards.
 */
export interface CompiledRole {
  readonly roleId: Uuid;
  /** `objectType + ":" + action` -> widest scope granted by this role. */
  readonly grants: ReadonlyMap<string, Scope>;
  /** `objectType + ":" + fieldKey` -> explicit field override. */
  readonly fieldOverrides: ReadonlyMap<string, FieldAccess>;
}

export interface PermissionSet {
  readonly roles: readonly CompiledRole[];
}

/**
 * Who is acting.
 *
 * Every value here is derived from the server-side session, never from the
 * request body, query string or a header (CLAUDE.md §5.2). Constructing an Actor
 * from client input is the single easiest way to defeat this whole engine.
 */
export interface Actor {
  readonly userId: Uuid;
  readonly tenantId: Uuid;
  /** Teams the actor belongs to, used to resolve `team` scope. */
  readonly teamIds: readonly Uuid[];
  readonly permissions: PermissionSet;
}

/** The ownership facts `can()` needs to judge a specific record. */
export interface RecordRef {
  readonly ownerId: string | null;
  readonly teamId?: string | null;
}

/** Collection-level check (no record yet) or record-level check. */
export interface Resource {
  readonly objectType: ObjectType;
  readonly record?: RecordRef;
}

/**
 * The scoping a repository must apply in SQL.
 *
 * Returned rather than applied here so that scoping becomes a WHERE clause
 * instead of a post-fetch filter — filtering after the fact would page over rows
 * the actor may not see and quietly corrupt keyset pagination (ADR-0012).
 */
export type RecordConstraint =
  | { readonly kind: 'all' }
  | { readonly kind: 'team'; readonly userId: Uuid; readonly teamIds: readonly Uuid[] }
  | { readonly kind: 'own'; readonly userId: Uuid };

export type DenyReason =
  /** No role grants this action on this object type at all. */
  | 'no_grant'
  /** The action is granted, but this record falls outside the actor's scope. */
  | 'out_of_scope';

export type Decision =
  | {
      readonly allowed: true;
      readonly scope: Scope;
      readonly constraint: RecordConstraint;
    }
  | {
      readonly allowed: false;
      readonly reason: DenyReason;
    };
