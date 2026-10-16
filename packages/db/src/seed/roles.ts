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

/** The business objects a role can be granted on. Leads and deals follow. */
const BUSINESS_OBJECTS = ['account', 'contact'] as const;

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

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    name: 'Owner',
    description: 'Full control of the company account, including billing and security settings.',
    grants: grantsFor(ALL_ACTIONS, 'all'),
  },
  {
    name: 'Admin',
    description: 'Manages users, roles and customization. Sees all records.',
    grants: grantsFor(ALL_ACTIONS, 'all'),
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
