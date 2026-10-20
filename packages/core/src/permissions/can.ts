import { ForbiddenError, NotFoundError } from '../errors/index.js';
import type { Action, Scope } from '../objects/index.js';
import { scopeRank, widestScope } from '../objects/index.js';
import { grantKey } from './compile.js';
import type {
  Actor,
  Decision,
  Derivation,
  GrantSource,
  RecordConstraint,
  RecordMatch,
  RecordRef,
  Resource,
} from './types.js';

/**
 * The one authorization decision point (ADR-0008, CLAUDE.md §5.3).
 *
 * **Default deny.** An action with no matching grant is refused. There is no
 * super-user short circuit here: an Owner is simply a role whose rows grant
 * everything at `all` scope, which keeps that power visible in data and in the
 * audit log rather than hidden in a branch.
 *
 * Called without `resource.record` it answers "may this actor do this at all?"
 * and hands back the `constraint` the repository must put into its WHERE clause.
 * Called with a record it additionally judges that specific record.
 *
 * ## It also reports its reasoning (ADR-0031)
 *
 * Every decision carries a `derivation`: which roles granted the action, at
 * which scopes, which of them decided, and why the record did or did not
 * satisfy the constraint. The access explainer is built on that field and on
 * nothing else, so what it tells an administrator is the output of this
 * function rather than a second reading of the same tables — a second reader
 * would drift, and a permissions explainer that drifts is worse than none.
 *
 * The derivation is **assembled from the values the decision is taken on**, in
 * the same pass. Nothing below branches on it, so the decision is exactly what
 * it was before the field existed.
 */
export function can(actor: Actor, action: Action, resource: Resource): Decision {
  let scope: Scope | null = null;
  let decidingRoleId: Derivation['decidingRoleId'] = null;
  const grants: GrantSource[] = [];

  // A user may hold several roles; their reach is the union of those roles.
  for (const role of actor.permissions.roles) {
    const granted = role.grants.get(grantKey(resource.objectType, action));
    if (granted !== undefined) {
      grants.push({ roleId: role.roleId, scope: granted });
      // The first role at the widest scope is the one that decides; a later
      // role granting the same scope changes nothing and should not take the
      // credit for it.
      if (scope === null || scopeRank(granted) > scopeRank(scope)) decidingRoleId = role.roleId;
      scope = scope === null ? granted : widestScope(scope, granted);
    }
  }

  const derivation = (recordMatch: RecordMatch | null): Derivation => ({
    objectType: resource.objectType,
    action,
    grants,
    effectiveScope: scope,
    decidingRoleId,
    recordMatch,
  });

  if (scope === null) {
    return { allowed: false, reason: 'no_grant', derivation: derivation(null) };
  }

  const constraint = constraintFor(scope, actor);

  if (resource.record === undefined) {
    return { allowed: true, scope, constraint, derivation: derivation(null) };
  }

  const match = matchConstraint(constraint, resource.record);

  return match.satisfied
    ? { allowed: true, scope, constraint, derivation: derivation(match) }
    : { allowed: false, reason: 'out_of_scope', derivation: derivation(match) };
}

/** Translate a scope into the constraint a repository applies in SQL. */
export function constraintFor(scope: Scope, actor: Actor): RecordConstraint {
  switch (scope) {
    case 'all':
      return { kind: 'all' };
    case 'team':
      return { kind: 'team', userId: actor.userId, teamIds: actor.teamIds };
    case 'own':
      return { kind: 'own', userId: actor.userId };
  }
}

/**
 * Which of the actor's teams the record's owner also belongs to, if any.
 *
 * `teamId` is checked first and on its own, because that is the only fact this
 * matcher had before `ownerTeamIds` existed, and callers that pass it must keep
 * getting the same answer.
 */
function sharedTeam(teamIds: readonly string[], record: RecordRef): string | null {
  const direct = record.teamId;
  if (direct != null && teamIds.some((id) => id === direct)) return direct;

  const ownerTeams = record.ownerTeamIds;
  if (ownerTeams !== undefined) {
    for (const id of ownerTeams) {
      if (teamIds.some((mine) => mine === id)) return id;
    }
  }
  return null;
}

/**
 * Whether a record satisfies a constraint, **and why**.
 *
 * Kept beside `constraintFor` on purpose: this is the in-memory twin of the SQL
 * the repository generates, and the two must agree. A record with no owner never
 * satisfies `own` or `team` — unowned records are visible only at `all` scope.
 *
 * The reason is produced here rather than reconstructed later, so "Priya,
 * because she owns it" and "allowed" are two readings of one evaluation
 * (ADR-0031).
 */
export function matchConstraint(constraint: RecordConstraint, record: RecordRef): RecordMatch {
  switch (constraint.kind) {
    case 'all':
      return { satisfied: true, basis: 'unscoped' };
    case 'own':
      if (record.ownerId === null) return { satisfied: false, basis: 'unowned' };
      return record.ownerId === constraint.userId
        ? { satisfied: true, basis: 'owner' }
        : { satisfied: false, basis: 'not_owner' };
    case 'team': {
      if (record.ownerId !== null && record.ownerId === constraint.userId) {
        return { satisfied: true, basis: 'owner' };
      }
      const shared = sharedTeam(constraint.teamIds, record);
      if (shared !== null) return { satisfied: true, basis: 'team', teamId: shared };
      return record.ownerId === null
        ? { satisfied: false, basis: 'unowned' }
        : { satisfied: false, basis: 'no_shared_team' };
    }
  }
}

/** Whether a record satisfies a constraint. The decision half of `matchConstraint`. */
export function satisfiesConstraint(constraint: RecordConstraint, record: RecordRef): boolean {
  return matchConstraint(constraint, record).satisfied;
}

/**
 * Authorize or throw.
 *
 * A record the actor may not reach raises **404, not 403** (CLAUDE.md §5.5):
 * a 403 would confirm that the id exists, turning the endpoint into an existence
 * oracle for records in other tenants or other reps' books. Lacking the grant
 * entirely is a plain 403, which reveals nothing about any particular record.
 */
export function assertCan(actor: Actor, action: Action, resource: Resource): Decision {
  const decision = can(actor, action, resource);
  if (decision.allowed) return decision;

  if (decision.reason === 'out_of_scope') {
    throw new NotFoundError(resource.objectType);
  }
  throw new ForbiddenError();
}
