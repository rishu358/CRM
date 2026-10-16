import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors/index.js';
import { newId, type Uuid } from '../ids/index.js';
import { ACTIONS, type Action, type Scope } from '../objects/index.js';
import { assertCan, can, satisfiesConstraint } from './can.js';
import { makeActor } from './testing.js';
import type { RolePermissionRow } from './types.js';

const SALES_REP_ROLE = newId();
const MANAGER_ROLE = newId();

function grant(
  roleId: Uuid,
  objectType: 'contact' | 'deal',
  action: Action,
  scope: Scope,
): RolePermissionRow {
  return { roleId, objectType, action, scope };
}

describe('default deny (CLAUDE.md §5.3)', () => {
  it('denies every action to an actor with no roles', () => {
    const actor = makeActor({});
    for (const action of ACTIONS) {
      const decision = can(actor, action, { objectType: 'contact' });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('no_grant');
    }
  });

  it('does not leak a grant across object types', () => {
    const actor = makeActor({
      rolePermissions: [grant(SALES_REP_ROLE, 'contact', 'read', 'all')],
    });
    expect(can(actor, 'read', { objectType: 'contact' }).allowed).toBe(true);
    expect(can(actor, 'read', { objectType: 'deal' }).allowed).toBe(false);
  });

  it('does not leak a grant across actions', () => {
    const actor = makeActor({
      rolePermissions: [grant(SALES_REP_ROLE, 'contact', 'read', 'all')],
    });
    expect(can(actor, 'update', { objectType: 'contact' }).allowed).toBe(false);
    expect(can(actor, 'delete', { objectType: 'contact' }).allowed).toBe(false);
    expect(can(actor, 'export', { objectType: 'contact' }).allowed).toBe(false);
  });
});

describe('own scope', () => {
  const ownerId = newId();
  const actor = makeActor({
    userId: ownerId,
    rolePermissions: [grant(SALES_REP_ROLE, 'contact', 'read', 'own')],
  });

  it('allows the actor to read their own record', () => {
    expect(can(actor, 'read', { objectType: 'contact', record: { ownerId } }).allowed).toBe(true);
  });

  it('denies another user record as out of scope', () => {
    const decision = can(actor, 'read', {
      objectType: 'contact',
      record: { ownerId: newId() },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('out_of_scope');
  });

  it('denies an unowned record', () => {
    expect(can(actor, 'read', { objectType: 'contact', record: { ownerId: null } }).allowed).toBe(
      false,
    );
  });

  it('hands the repository an own-scoped constraint for list queries', () => {
    const decision = can(actor, 'read', { objectType: 'contact' });
    expect(decision.allowed && decision.constraint).toEqual({ kind: 'own', userId: ownerId });
  });
});

describe('team scope', () => {
  const userId = newId();
  const teamId = newId();
  const otherTeamId = newId();
  const actor = makeActor({
    userId,
    teamIds: [teamId],
    rolePermissions: [grant(MANAGER_ROLE, 'deal', 'read', 'team')],
  });

  it('allows a teammate record', () => {
    expect(
      can(actor, 'read', { objectType: 'deal', record: { ownerId: newId(), teamId } }).allowed,
    ).toBe(true);
  });

  it('allows the actor their own record even without a team on it', () => {
    expect(
      can(actor, 'read', { objectType: 'deal', record: { ownerId: userId, teamId: null } }).allowed,
    ).toBe(true);
  });

  it('denies a record belonging to another team', () => {
    expect(
      can(actor, 'read', {
        objectType: 'deal',
        record: { ownerId: newId(), teamId: otherTeamId },
      }).allowed,
    ).toBe(false);
  });

  it('denies a teamless record owned by someone else', () => {
    expect(
      can(actor, 'read', { objectType: 'deal', record: { ownerId: newId(), teamId: null } })
        .allowed,
    ).toBe(false);
  });
});

describe('all scope', () => {
  const actor = makeActor({
    rolePermissions: [grant(MANAGER_ROLE, 'contact', 'read', 'all')],
  });

  it('allows any record, owned or not', () => {
    expect(
      can(actor, 'read', { objectType: 'contact', record: { ownerId: newId() } }).allowed,
    ).toBe(true);
    expect(can(actor, 'read', { objectType: 'contact', record: { ownerId: null } }).allowed).toBe(
      true,
    );
  });
});

describe('multiple roles combine as a union', () => {
  it('takes the widest scope across roles', () => {
    const actor = makeActor({
      rolePermissions: [
        grant(SALES_REP_ROLE, 'deal', 'read', 'own'),
        grant(MANAGER_ROLE, 'deal', 'read', 'all'),
      ],
    });
    expect(can(actor, 'read', { objectType: 'deal' }).allowed).toBe(true);
    const decision = can(actor, 'read', { objectType: 'deal' });
    expect(decision.allowed && decision.scope).toBe('all');
  });

  it('takes the widest scope within a single role too', () => {
    const actor = makeActor({
      rolePermissions: [
        grant(SALES_REP_ROLE, 'deal', 'read', 'own'),
        grant(SALES_REP_ROLE, 'deal', 'read', 'team'),
      ],
    });
    const decision = can(actor, 'read', { objectType: 'deal' });
    expect(decision.allowed && decision.scope).toBe('team');
  });
});

describe('satisfiesConstraint mirrors the SQL the repository builds', () => {
  const userId = newId();
  const teamId = newId();

  it('agrees with the all constraint', () => {
    expect(satisfiesConstraint({ kind: 'all' }, { ownerId: null })).toBe(true);
  });

  it('agrees with the own constraint', () => {
    expect(satisfiesConstraint({ kind: 'own', userId }, { ownerId: userId })).toBe(true);
    expect(satisfiesConstraint({ kind: 'own', userId }, { ownerId: newId() })).toBe(false);
  });

  it('agrees with the team constraint', () => {
    const constraint = { kind: 'team', userId, teamIds: [teamId] } as const;
    expect(satisfiesConstraint(constraint, { ownerId: newId(), teamId })).toBe(true);
    expect(satisfiesConstraint(constraint, { ownerId: newId(), teamId: newId() })).toBe(false);
  });
});

describe('assertCan error mapping (CLAUDE.md §5.5)', () => {
  it('throws 403 when the actor holds no grant at all', () => {
    expect(() => assertCan(makeActor({}), 'read', { objectType: 'contact' })).toThrow(
      ForbiddenError,
    );
  });

  it('throws 404, not 403, for a record outside the actor scope', () => {
    // A 403 here would confirm the id exists, making the endpoint an oracle.
    const actor = makeActor({
      rolePermissions: [grant(SALES_REP_ROLE, 'contact', 'read', 'own')],
    });
    expect(() =>
      assertCan(actor, 'read', { objectType: 'contact', record: { ownerId: newId() } }),
    ).toThrow(NotFoundError);
  });

  it('returns the decision when allowed', () => {
    const actor = makeActor({
      rolePermissions: [grant(MANAGER_ROLE, 'contact', 'read', 'all')],
    });
    expect(assertCan(actor, 'read', { objectType: 'contact' }).allowed).toBe(true);
  });
});
