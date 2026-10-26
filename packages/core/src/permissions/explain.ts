import { scopeRank, type Action, type ObjectType, type Scope } from '../objects/index.js';
import type { Uuid } from '../ids/index.js';
import { can } from './can.js';
import { fieldAccess, fieldAccessDerivation } from './field-access.js';
import type { Actor, FieldAccess, RecordRef } from './types.js';

/**
 * The access explainer (ADR-0033).
 *
 * Every function here is a **reading of `can()` and `fieldAccess()`**, never a
 * second opinion about what the rules are. The pattern is always the same: run
 * the real decision for the real actor, then translate the `derivation` it
 * reports into something an administrator can read. Nothing in this file looks
 * at `role_permissions`, `field_permissions` or `team_members` itself, and
 * nothing in it branches on a role name.
 *
 * That constraint is the whole point. An explainer that computes its answer a
 * second way will eventually disagree with the engine, and the first anyone
 * hears of it is a customer saying "it told me she couldn't see this". The
 * engine is therefore the thing that explains, and this module only phrases it.
 */

/**
 * Why an actor can or cannot reach a record.
 *
 * Stable codes, not sentences: the wording belongs in the UI's i18n layer, and
 * the public API should not change when a translator improves a phrase.
 */
export type AccessBasis =
  /** Allowed: the actor owns the record. */
  | 'owner'
  /** Allowed: the actor shares a team with the owner. */
  | 'shared_team'
  /** Allowed: the actor's scope covers every record of this type. */
  | 'all_records'
  /** Denied: no role the actor holds grants this action on this object at all. */
  | 'no_grant'
  /** Denied: somebody else owns it and the actor's scope is `own`. */
  | 'not_owner'
  /** Denied: the owner is outside every team the actor belongs to. */
  | 'no_shared_team'
  /** Denied: nobody owns it, so neither `own` nor `team` scope reaches it. */
  | 'unowned';

export interface RecordAccess {
  readonly allowed: boolean;
  /** The scope the actor's roles settled on, or `null` when nothing granted it. */
  readonly scope: Scope | null;
  readonly basis: AccessBasis;
  /** The role that decided it. `null` when nothing granted the action. */
  readonly viaRoleId: Uuid | null;
  /** Which team they share with the owner, when that is the reason. */
  readonly sharedTeamId: string | null;
}

/**
 * Can this actor do this to this record, and why?
 *
 * One call to `can()`; everything else here is the translation of what it
 * reported.
 */
export function explainRecordAccess(
  actor: Actor,
  action: Action,
  objectType: ObjectType,
  record: RecordRef,
): RecordAccess {
  const decision = can(actor, action, { objectType, record });
  const { derivation } = decision;
  const match = derivation.recordMatch;

  const basis: AccessBasis =
    match === null
      ? 'no_grant'
      : match.basis === 'unscoped'
        ? 'all_records'
        : match.basis === 'team'
          ? 'shared_team'
          : match.basis;

  return {
    allowed: decision.allowed,
    scope: derivation.effectiveScope,
    basis,
    viaRoleId: derivation.decidingRoleId,
    sharedTeamId: match !== null && match.satisfied && match.basis === 'team' ? match.teamId : null,
  };
}

/** One actor's access to one field, phrased for the explainer. */
export interface FieldVisibility {
  readonly fieldKey: string;
  readonly access: FieldAccess;
  /** The role that decided it, or `null` when no role allows anything here. */
  readonly viaRoleId: Uuid | null;
  /**
   * Why it is not fully visible.
   *
   * `object` — the role cannot read the object at all, so every field is dark.
   * `field_rule` — the object is readable and a `field_permissions` row narrowed
   * this one. The difference matters: the fix is in two different places.
   */
  readonly narrowedBy: 'object' | 'field_rule' | null;
}

export function explainFieldVisibility(
  actor: Actor,
  objectType: ObjectType,
  fieldKey: string,
): FieldVisibility {
  const derivation = fieldAccessDerivation(actor, objectType, fieldKey);

  // Whether any role could have read the object before field rules applied.
  // When none could, the object-level grant is what hides the field.
  const readableAtObjectLevel = derivation.roles.some((role) => role.base !== 'hidden');
  const narrowedByRule = derivation.roles.some(
    (role) => role.override !== undefined && role.access !== role.base,
  );

  return {
    fieldKey,
    access: derivation.access,
    viaRoleId: derivation.decidingRoleId,
    narrowedBy:
      derivation.access === 'write'
        ? null
        : !readableAtObjectLevel
          ? 'object'
          : narrowedByRule
            ? 'field_rule'
            : null,
  };
}

// ---------------------------------------------------------------------------
// The other direction: what can this subject reach?
// ---------------------------------------------------------------------------

export interface ActionReach {
  readonly action: Action;
  readonly allowed: boolean;
  readonly scope: Scope | null;
  readonly viaRoleId: Uuid | null;
}

export interface ObjectReach {
  readonly objectType: ObjectType;
  readonly actions: readonly ActionReach[];
  /** Field access across this object, in the order the fields were given. */
  readonly fields: readonly FieldVisibility[];
}

/**
 * Everything an actor can reach, object by object.
 *
 * `can()` is asked once per object/action pair exactly as an endpoint would ask
 * it, with no record — which is the same question a list endpoint asks, so the
 * scope reported here is the scope that will be compiled into its WHERE clause.
 */
export function explainReach(
  actor: Actor,
  objects: readonly { readonly objectType: ObjectType; readonly fieldKeys: readonly string[] }[],
  actions: readonly Action[],
): ObjectReach[] {
  return objects.map(({ objectType, fieldKeys }) => ({
    objectType,
    actions: actions.map((action) => {
      const decision = can(actor, action, { objectType });
      return {
        action,
        allowed: decision.allowed,
        scope: decision.derivation.effectiveScope,
        viaRoleId: decision.derivation.decidingRoleId,
      };
    }),
    fields: fieldKeys.map((fieldKey) => explainFieldVisibility(actor, objectType, fieldKey)),
  }));
}

// ---------------------------------------------------------------------------
// What a proposed change would do
// ---------------------------------------------------------------------------

export interface ScopeChange {
  readonly objectType: ObjectType;
  readonly action: Action;
  readonly before: Scope | null;
  readonly after: Scope | null;
  /** `narrowed` takes records away; `widened` adds them; `revoked`/`granted` flip it entirely. */
  readonly direction: 'granted' | 'revoked' | 'widened' | 'narrowed';
}

export interface FieldChange {
  readonly objectType: ObjectType;
  readonly fieldKey: string;
  readonly before: FieldAccess;
  readonly after: FieldAccess;
}

export interface AccessDiff {
  readonly scopeChanges: readonly ScopeChange[];
  readonly fieldChanges: readonly FieldChange[];
}

/**
 * What changes for one person between two permission configurations.
 *
 * Both sides are real `Actor`s compiled by `compilePermissions`, and both are
 * asked through `can()`, so this is a diff of **effect** — what the engine will
 * decide — rather than a diff of the rows an administrator edited. That is the
 * difference between "you changed the `contact.read` row from `all` to `team`"
 * and "this removes 1,240 contacts from Priya's view", and only the second one
 * tells somebody whether to click save.
 *
 * Record counts are not here because they are a database question; the API
 * counts them under each side's `constraint`, which `can()` hands it.
 */
export function diffAccess(
  before: Actor,
  after: Actor,
  objects: readonly { readonly objectType: ObjectType; readonly fieldKeys: readonly string[] }[],
  actions: readonly Action[],
): AccessDiff {
  const scopeChanges: ScopeChange[] = [];
  const fieldChanges: FieldChange[] = [];

  for (const { objectType, fieldKeys } of objects) {
    for (const action of actions) {
      const was = can(before, action, { objectType }).derivation.effectiveScope;
      const now = can(after, action, { objectType }).derivation.effectiveScope;
      if (was === now) continue;

      scopeChanges.push({
        objectType,
        action,
        before: was,
        after: now,
        direction: direction(was, now),
      });
    }

    for (const fieldKey of fieldKeys) {
      const was = fieldAccess(before, objectType, fieldKey);
      const now = fieldAccess(after, objectType, fieldKey);
      if (was !== now) fieldChanges.push({ objectType, fieldKey, before: was, after: now });
    }
  }

  return { scopeChanges, fieldChanges };
}

function direction(before: Scope | null, after: Scope | null): ScopeChange['direction'] {
  if (before === null) return 'granted';
  if (after === null) return 'revoked';
  return scopeRank(after) > scopeRank(before) ? 'widened' : 'narrowed';
}
