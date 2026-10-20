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
  /**
   * The teams the record's **owner** belongs to.
   *
   * A record has no team column: in SQL, `team` scope means "owned by anyone in
   * my teams", read through `team_members` (see `constraintToSql`). The
   * in-memory twin therefore needs the same fact, and an owner can be in more
   * than one team, which the single `teamId` above cannot express.
   *
   * Optional, and absent means "not resolved" rather than "none": leaving it
   * out gives exactly the behaviour this type had before the field existed, so
   * a caller that only ever deals in `own` or `all` scope pays nothing for it.
   */
  readonly ownerTeamIds?: readonly string[];
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
      readonly derivation: Derivation;
    }
  | {
      readonly allowed: false;
      readonly reason: DenyReason;
      readonly derivation: Derivation;
    };

// ---------------------------------------------------------------------------
// Reasoning (ADR-0031)
// ---------------------------------------------------------------------------

/**
 * One role's contribution to a decision.
 *
 * A user may hold several roles, and when they do the question "why can she see
 * this?" has a specific answer — *this* role, granting *this* scope. The
 * explainer needs that answer and `can()` is the only thing that knows it, so
 * it reports it rather than letting a second reader of `role_permissions`
 * guess.
 */
export interface GrantSource {
  readonly roleId: Uuid;
  readonly scope: Scope;
}

/**
 * Why a record did or did not satisfy the actor's constraint.
 *
 * `basis` is the human-facing half of the answer: "she owns it", "he shares a
 * team with the owner", "her role reaches everything". `satisfied` is the
 * machine-facing half, and `satisfiesConstraint` is now literally this field —
 * there is one matcher, not one that decides and another that narrates.
 */
export type RecordMatch =
  /** `all` scope: there was nothing to check. */
  | { readonly satisfied: true; readonly basis: 'unscoped' }
  /** The actor is the record's owner. */
  | { readonly satisfied: true; readonly basis: 'owner' }
  /** The actor shares this team with the record's owner. */
  | { readonly satisfied: true; readonly basis: 'team'; readonly teamId: string }
  /** Owned, but by somebody else, and the actor's scope is `own`. */
  | { readonly satisfied: false; readonly basis: 'not_owner' }
  /** Owned by somebody outside every team the actor belongs to. */
  | { readonly satisfied: false; readonly basis: 'no_shared_team' }
  /** Nobody owns it, so no `own` or `team` scope can reach it. */
  | { readonly satisfied: false; readonly basis: 'unowned' };

/**
 * The facts a decision was made from.
 *
 * Carried on **both** branches of `Decision`, because "why not?" is as much a
 * question an administrator asks as "why?". It is assembled by `can()` as it
 * decides, from the same values the decision is taken on, so it cannot describe
 * rules other than the ones that were applied (ADR-0031).
 */
export interface Derivation {
  readonly objectType: ObjectType;
  readonly action: Action;
  /** Every role that granted this action, and at what scope. Empty = denied. */
  readonly grants: readonly GrantSource[];
  /** The union of those scopes; `null` when nothing granted the action. */
  readonly effectiveScope: Scope | null;
  /** The first role holding the widest grant — the one that decides. */
  readonly decidingRoleId: Uuid | null;
  /** Present only when `can()` was given a record to judge. */
  readonly recordMatch: RecordMatch | null;
}
