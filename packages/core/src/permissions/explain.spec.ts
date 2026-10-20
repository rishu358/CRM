import { describe, expect, it } from 'vitest';
import { newId, type Uuid } from '../ids/index.js';
import {
  ACTIONS,
  OBJECT_TYPES,
  SCOPES,
  type Action,
  type ObjectType,
  type Scope,
} from '../objects/index.js';
import { can, matchConstraint, satisfiesConstraint } from './can.js';
import {
  diffAccess,
  explainFieldVisibility,
  explainReach,
  explainRecordAccess,
} from './explain.js';
import { fieldAccess, fieldAccessDerivation } from './field-access.js';
import { makeActor } from './testing.js';
import { FIELD_ACCESS_LEVELS, type FieldPermissionRow, type RolePermissionRow } from './types.js';

/**
 * The explainer's contract (ADR-0031).
 *
 * Two kinds of test live here, and the second kind is the one that matters.
 *
 * The first checks that the reasons are the right reasons — that a record the
 * actor owns is explained as `owner` and not merely as "allowed".
 *
 * The second checks that **the explainer and the engine cannot disagree**. The
 * failure this guards against is not a wrong sentence, it is a second
 * implementation drifting away from the first; so wherever the explainer takes
 * a path that is not literally the decision path — `fieldAccessDerivation`
 * beside `fieldAccess`, `matchConstraint` beside `satisfiesConstraint` — a test
 * here asserts the two agree over the whole matrix of inputs rather than on a
 * hand-picked example. The API-level counterpart asserts the same thing against
 * what the HTTP endpoints actually return.
 */

const ROLE_A = newId();
const ROLE_B = newId();

function grant(
  roleId: Uuid,
  objectType: ObjectType,
  action: Action,
  scope: Scope,
): RolePermissionRow {
  return { roleId, objectType, action, scope };
}

function fieldRule(
  roleId: Uuid,
  objectType: ObjectType,
  fieldKey: string,
  access: FieldPermissionRow['access'],
): FieldPermissionRow {
  return { roleId, objectType, fieldKey, access };
}

describe('why an actor can reach a record', () => {
  const userId = newId();
  const teamId = newId();

  it('explains an owned record as ownership, naming the role that allows it', () => {
    const actor = makeActor({
      userId,
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'own')],
    });

    const access = explainRecordAccess(actor, 'read', 'contact', { ownerId: userId });

    expect(access).toEqual({
      allowed: true,
      scope: 'own',
      basis: 'owner',
      viaRoleId: ROLE_A,
      sharedTeamId: null,
    });
  });

  it('explains a teammate record as a shared team, and says which team', () => {
    const actor = makeActor({
      userId,
      teamIds: [teamId],
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'team')],
    });

    const access = explainRecordAccess(actor, 'read', 'contact', {
      ownerId: newId(),
      ownerTeamIds: [teamId],
    });

    expect(access.allowed).toBe(true);
    expect(access.basis).toBe('shared_team');
    expect(access.sharedTeamId).toBe(teamId);
  });

  it('explains an `all`-scope reach as reaching everything, not as ownership', () => {
    const actor = makeActor({
      userId,
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')],
    });

    // Owned by this very actor, but that is not why they can see it: the
    // distinction decides whether taking the role away changes anything.
    const access = explainRecordAccess(actor, 'read', 'contact', { ownerId: userId });
    expect(access.basis).toBe('all_records');
  });

  it('distinguishes "no grant at all" from "out of scope"', () => {
    const noGrant = makeActor({ userId });
    expect(explainRecordAccess(noGrant, 'read', 'contact', { ownerId: userId }).basis).toBe(
      'no_grant',
    );
    expect(explainRecordAccess(noGrant, 'read', 'contact', { ownerId: userId }).viaRoleId).toBeNull();

    const ownOnly = makeActor({
      userId,
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'own')],
    });
    expect(explainRecordAccess(ownOnly, 'read', 'contact', { ownerId: newId() }).basis).toBe(
      'not_owner',
    );
    expect(explainRecordAccess(ownOnly, 'read', 'contact', { ownerId: null }).basis).toBe(
      'unowned',
    );

    const teamOnly = makeActor({
      userId,
      teamIds: [teamId],
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'team')],
    });
    expect(
      explainRecordAccess(teamOnly, 'read', 'contact', { ownerId: newId(), ownerTeamIds: [newId()] })
        .basis,
    ).toBe('no_shared_team');
  });

  it('names the widest role when the actor holds several', () => {
    const actor = makeActor({
      userId,
      rolePermissions: [
        grant(ROLE_A, 'contact', 'read', 'own'),
        grant(ROLE_B, 'contact', 'read', 'all'),
      ],
    });

    const access = explainRecordAccess(actor, 'read', 'contact', { ownerId: newId() });
    expect(access.allowed).toBe(true);
    expect(access.viaRoleId).toBe(ROLE_B);
    expect(access.scope).toBe('all');
  });
});

describe('why a field is or is not visible', () => {
  it('blames the object grant when the role cannot read the object at all', () => {
    const actor = makeActor({ rolePermissions: [grant(ROLE_A, 'deal', 'read', 'all')] });
    const visibility = explainFieldVisibility(actor, 'contact', 'phone');

    expect(visibility.access).toBe('hidden');
    expect(visibility.narrowedBy).toBe('object');
    expect(visibility.viaRoleId).toBeNull();
  });

  it('blames the field rule when the object is readable and the field is not', () => {
    const actor = makeActor({
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')],
      fieldPermissions: [fieldRule(ROLE_A, 'contact', 'phone', 'hidden')],
    });

    const visibility = explainFieldVisibility(actor, 'contact', 'phone');
    expect(visibility.access).toBe('hidden');
    expect(visibility.narrowedBy).toBe('field_rule');
  });

  it('reports read-only without blaming a field rule that is not there', () => {
    const actor = makeActor({ rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')] });
    const visibility = explainFieldVisibility(actor, 'contact', 'phone');

    expect(visibility.access).toBe('read');
    expect(visibility.narrowedBy).toBeNull();
    expect(visibility.viaRoleId).toBe(ROLE_A);
  });
});

describe('what a subject can reach', () => {
  it('reports the scope a list endpoint would compile, per object and action', () => {
    const actor = makeActor({
      rolePermissions: [
        grant(ROLE_A, 'contact', 'read', 'team'),
        grant(ROLE_A, 'contact', 'export', 'own'),
        grant(ROLE_A, 'deal', 'read', 'all'),
      ],
    });

    const reach = explainReach(
      actor,
      [
        { objectType: 'contact', fieldKeys: ['phone'] },
        { objectType: 'deal', fieldKeys: [] },
      ],
      ['read', 'export', 'delete'],
    );

    const contact = reach.find((entry) => entry.objectType === 'contact')!;
    expect(contact.actions).toEqual([
      { action: 'read', allowed: true, scope: 'team', viaRoleId: ROLE_A },
      { action: 'export', allowed: true, scope: 'own', viaRoleId: ROLE_A },
      { action: 'delete', allowed: false, scope: null, viaRoleId: null },
    ]);
    expect(contact.fields).toEqual([
      { fieldKey: 'phone', access: 'read', viaRoleId: ROLE_A, narrowedBy: null },
    ]);
  });
});

describe('what a proposed change would do', () => {
  const objects = [{ objectType: 'contact' as const, fieldKeys: ['phone', 'email'] }];

  it('reports a narrowed scope as narrowed, not merely as changed', () => {
    const before = makeActor({ rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')] });
    const after = makeActor({ rolePermissions: [grant(ROLE_A, 'contact', 'read', 'team')] });

    const diff = diffAccess(before, after, objects, ['read']);
    expect(diff.scopeChanges).toEqual([
      {
        objectType: 'contact',
        action: 'read',
        before: 'all',
        after: 'team',
        direction: 'narrowed',
      },
    ]);
  });

  it('reports a revoked grant and a granted one as such', () => {
    const none = makeActor({});
    const some = makeActor({ rolePermissions: [grant(ROLE_A, 'contact', 'read', 'own')] });

    expect(diffAccess(none, some, objects, ['read']).scopeChanges[0]?.direction).toBe('granted');
    expect(diffAccess(some, none, objects, ['read']).scopeChanges[0]?.direction).toBe('revoked');
  });

  it('reports a field that is about to go dark', () => {
    const before = makeActor({ rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')] });
    const after = makeActor({
      rolePermissions: [grant(ROLE_A, 'contact', 'read', 'all')],
      fieldPermissions: [fieldRule(ROLE_A, 'contact', 'phone', 'hidden')],
    });

    const diff = diffAccess(before, after, objects, ['read']);
    expect(diff.scopeChanges).toEqual([]);
    expect(diff.fieldChanges).toEqual([
      { objectType: 'contact', fieldKey: 'phone', before: 'read', after: 'hidden' },
    ]);
  });

  it('says nothing when nothing changes', () => {
    const rows = [grant(ROLE_A, 'contact', 'read', 'team')];
    const diff = diffAccess(
      makeActor({ rolePermissions: rows }),
      makeActor({ rolePermissions: rows }),
      objects,
      [...ACTIONS],
    );
    expect(diff).toEqual({ scopeChanges: [], fieldChanges: [] });
  });
});

// ---------------------------------------------------------------------------
// The explainer and the engine cannot disagree
// ---------------------------------------------------------------------------

describe('the explainer agrees with the engine it explains', () => {
  const userId = newId();
  const sharedTeam = newId();
  const otherTeam = newId();

  /** Every shape of actor the engine distinguishes. */
  const actors = SCOPES.flatMap((scope) => [
    {
      name: `contact:read at ${scope}`,
      actor: makeActor({
        userId,
        teamIds: [sharedTeam],
        rolePermissions: [grant(ROLE_A, 'contact', 'read', scope)],
      }),
    },
    {
      name: `contact:read at ${scope}, with a field rule`,
      actor: makeActor({
        userId,
        teamIds: [sharedTeam],
        rolePermissions: [
          grant(ROLE_A, 'contact', 'read', scope),
          grant(ROLE_A, 'contact', 'update', scope),
        ],
        fieldPermissions: [
          fieldRule(ROLE_A, 'contact', 'phone', 'hidden'),
          fieldRule(ROLE_A, 'contact', 'email', 'read'),
        ],
      }),
    },
    {
      name: `two roles, one at ${scope}`,
      actor: makeActor({
        userId,
        teamIds: [sharedTeam],
        rolePermissions: [
          grant(ROLE_A, 'contact', 'read', scope),
          grant(ROLE_B, 'contact', 'read', 'own'),
        ],
        fieldPermissions: [fieldRule(ROLE_B, 'contact', 'phone', 'hidden')],
      }),
    },
  ]);
  actors.push({ name: 'no roles at all', actor: makeActor({ userId }) });

  /** Every shape of record the matcher distinguishes. */
  const records = [
    { name: 'owned by the actor', record: { ownerId: userId } },
    { name: 'owned by a teammate', record: { ownerId: newId(), ownerTeamIds: [sharedTeam] } },
    { name: 'owned by a stranger', record: { ownerId: newId(), ownerTeamIds: [otherTeam] } },
    { name: 'owned by a teamless stranger', record: { ownerId: newId() } },
    { name: 'unowned', record: { ownerId: null } },
    { name: 'unowned, with a team', record: { ownerId: null, teamId: sharedTeam } },
  ];

  it('never claims access the engine denies, or denies access it allows', () => {
    for (const { name: actorName, actor } of actors) {
      for (const action of ACTIONS) {
        for (const { name: recordName, record } of records) {
          const explained = explainRecordAccess(actor, action, 'contact', record);
          const decided = can(actor, action, { objectType: 'contact', record });
          expect(
            explained.allowed,
            `${actorName} / ${action} / ${recordName}`,
          ).toBe(decided.allowed);
        }
      }
    }
  });

  it('reports a basis consistent with the decision in every case', () => {
    const allowedBases = ['owner', 'shared_team', 'all_records'];
    for (const { actor } of actors) {
      for (const action of ACTIONS) {
        for (const { record } of records) {
          const explained = explainRecordAccess(actor, action, 'contact', record);
          expect(allowedBases.includes(explained.basis)).toBe(explained.allowed);
        }
      }
    }
  });

  it('derives the same field access the serializer applies', () => {
    const keys = ['phone', 'email', 'first_name', 'custom_thing'];
    for (const { name, actor } of actors) {
      for (const objectType of OBJECT_TYPES) {
        for (const key of keys) {
          expect(
            fieldAccessDerivation(actor, objectType, key).access,
            `${name} / ${objectType} / ${key}`,
          ).toBe(fieldAccess(actor, objectType, key));
          expect(explainFieldVisibility(actor, objectType, key).access).toBe(
            fieldAccess(actor, objectType, key),
          );
        }
      }
    }
  });

  it('matches the constraint the same way the boolean does', () => {
    const constraints = [
      { kind: 'all' } as const,
      { kind: 'own', userId } as const,
      { kind: 'team', userId, teamIds: [sharedTeam] } as const,
      { kind: 'team', userId, teamIds: [] } as const,
    ];
    for (const constraint of constraints) {
      for (const { name, record } of records) {
        expect(matchConstraint(constraint, record).satisfied, `${constraint.kind} / ${name}`).toBe(
          satisfiesConstraint(constraint, record),
        );
      }
    }
  });

  it('covers every field access level the explainer can report', () => {
    // A guard on the matrix above rather than on the code: if a level is ever
    // added, this fails until the explainer is taught to produce it.
    const produced = new Set(
      actors.flatMap(({ actor }) =>
        ['phone', 'email', 'first_name'].map(
          (key) => explainFieldVisibility(actor, 'contact', key).access,
        ),
      ),
    );
    for (const level of FIELD_ACCESS_LEVELS) {
      expect(produced.has(level), level).toBe(true);
    }
  });
});
