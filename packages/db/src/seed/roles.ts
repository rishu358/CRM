import type { Action, Scope } from '@crm/core';

/**
 * The default roles every tenant starts with (MVP_SPEC §4).
 *
 * Seeded as rows, not encoded in code. `can()` reads only data, so an Owner has
 * no special case anywhere in the engine — it is simply the role granted
 * everything at `all` scope. Admins can then edit these or add custom roles
 * without a deploy.
 */

export interface SystemRoleGrant {
  readonly objectType: string;
  readonly actions: readonly Action[];
  readonly scope: Scope;
}

export interface SystemRoleDefinition {
  readonly name: string;
  readonly description: string;
  readonly grants: readonly SystemRoleGrant[];
}

/**
 * The business objects a role can be granted on.
 *
 * `activity` is one of them: tasks, calls, meetings and notes are records
 * with an owner and a scope like any other, so a Sales Rep sees the ones
 * assigned to them and a Manager sees the team's (MVP_SPEC M6). Tenants that
 * already existed when activities shipped are given the same grants by the
 * backfill in `0010_activities_module.sql`.
 */
const BUSINESS_OBJECTS = ['account', 'contact', 'lead', 'deal', 'activity'] as const;

const ALL_ACTIONS: readonly Action[] = [
  'read',
  'create',
  'update',
  'delete',
  'export',
  'import',
] as const;

function grantsFor(actions: readonly Action[], scope: Scope): SystemRoleGrant[] {
  return BUSINESS_OBJECTS.map((objectType) => ({ objectType, actions, scope }));
}

/**
 * Who may invite people into the workspace (MVP_SPEC M2).
 *
 * An invitation has no owner, so `own` and `team` would deny everything and
 * `all` is the only scope that means anything on it. Granted to Owner and
 * Admin alone — the two personas MVP_SPEC §4 describes as inviting the team
 * and managing users. Everyone else is denied by the absence of a row, which
 * is how every other denial in this engine works.
 *
 * `delete` is revocation. An invitation row is never actually deleted; the
 * action name is the one the permission model already has for "take this
 * away", and inventing a `revoke` action would mean every role editor,
 * permission matrix and API contract had to learn a verb used by one object.
 */
const INVITATION_GRANT: SystemRoleGrant = {
  objectType: 'invitation',
  actions: ['read', 'create', 'delete'],
  scope: 'all',
};

/**
 * Who may administer the workspace's own permission configuration (MVP_SPEC M3).
 *
 * `role`, `team` and `membership` have no owner, so — exactly like `invitation`
 * — `all` is the only scope that means anything on them, and the absence of a
 * row is what denies everyone else. Granted to Owner and Admin, the two
 * personas MVP_SPEC §4 describes as controlling who sees what.
 *
 * `role:read` is also the gate on the access explainer (ADR-0031). That is
 * deliberate rather than convenient: the explainer answers questions *about*
 * the permission configuration — who reaches a record, which fields are hidden
 * from whom — so the people who may read that configuration are exactly the
 * people who may ask it questions.
 */
const ADMINISTRATION_GRANTS: readonly SystemRoleGrant[] = [
  { objectType: 'role', actions: ['read', 'create', 'update', 'delete'], scope: 'all' },
  { objectType: 'team', actions: ['read', 'create', 'update', 'delete'], scope: 'all' },
  { objectType: 'membership', actions: ['read', 'update'], scope: 'all' },
];

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    name: 'Owner',
    description: 'Full control of the company account, including billing and security settings.',
    grants: [...grantsFor(ALL_ACTIONS, 'all'), INVITATION_GRANT, ...ADMINISTRATION_GRANTS],
  },
  {
    name: 'Admin',
    description: 'Manages users, roles and customization. Sees all records.',
    grants: [...grantsFor(ALL_ACTIONS, 'all'), INVITATION_GRANT, ...ADMINISTRATION_GRANTS],
  },
  {
    name: 'Manager',
    description: "Sees and manages the team's records, and can reassign work.",
    grants: grantsFor(['read', 'create', 'update', 'delete', 'export', 'import'], 'team'),
  },
  {
    name: 'Sales Rep',
    description: 'Works their own records. Cannot see other reps’ books.',
    grants: grantsFor(['read', 'create', 'update', 'export'], 'own'),
  },
  {
    name: 'Read-only',
    description: 'Views records and dashboards. Makes no changes.',
    // Read without export: an account or investor who can look at the pipeline
    // should not be able to walk out with the customer list.
    grants: grantsFor(['read'], 'all'),
  },
];

/** The role a brand-new tenant's first user receives. */
export const FOUNDING_ROLE_NAME = 'Owner';

/** The role an invited user gets when none is chosen. */
export const DEFAULT_INVITE_ROLE_NAME = 'Sales Rep';
