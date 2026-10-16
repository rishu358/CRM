import { ForbiddenError, NotFoundError } from '../errors/index.js';
import type { Action, Scope } from '../objects/index.js';
import { widestScope } from '../objects/index.js';
import { grantKey } from './compile.js';
import type { Actor, Decision, RecordConstraint, RecordRef, Resource } from './types.js';

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
 */
export function can(actor: Actor, action: Action, resource: Resource): Decision {
  let scope: Scope | null = null;

  // A user may hold several roles; their reach is the union of those roles.
  for (const role of actor.permissions.roles) {
    const granted = role.grants.get(grantKey(resource.objectType, action));
    if (granted !== undefined) {
      scope = scope === null ? granted : widestScope(scope, granted);
    }
  }

  if (scope === null) {
    return { allowed: false, reason: 'no_grant' };
  }

  const constraint = constraintFor(scope, actor);

  if (resource.record === undefined) {
    return { allowed: true, scope, constraint };
  }

  return satisfiesConstraint(constraint, resource.record)
    ? { allowed: true, scope, constraint }
    : { allowed: false, reason: 'out_of_scope' };
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
 * Whether a record satisfies a constraint.
 *
 * Kept beside `constraintFor` on purpose: this is the in-memory twin of the SQL
 * the repository generates, and the two must agree. A record with no owner never
 * satisfies `own` or `team` — unowned records are visible only at `all` scope.
 */
export function satisfiesConstraint(constraint: RecordConstraint, record: RecordRef): boolean {
  switch (constraint.kind) {
    case 'all':
      return true;
    case 'own':
      return record.ownerId !== null && record.ownerId === constraint.userId;
    case 'team': {
      if (record.ownerId !== null && record.ownerId === constraint.userId) return true;
      const teamId = record.teamId;
      return teamId != null && constraint.teamIds.includes(teamId);
    }
  }
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
