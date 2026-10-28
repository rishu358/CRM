import type { Action, ObjectType, Scope } from '../objects/index.js';
import { scopeRank } from '../objects/index.js';
import { can } from './can.js';
import type { Actor } from './types.js';

/**
 * What it makes sense to grant (MVP_SPEC M3).
 *
 * The role editor is metadata-driven (CLAUDE.md §6): the screen renders
 * whatever this says rather than hardcoding a matrix, and the API refuses to
 * **add** a grant that falls outside it. That second half matters more than it
 * looks. `import` on deals, `export` on activities and an `own` scope on an
 * invitation are all things the schema would happily store and nothing would
 * ever consult, so a screen that offered them would be showing an
 * administrator a switch wired to nothing — the sort of lie that surfaces
 * months later as "I turned that off".
 *
 * Existing rows outside the catalogue (the seed predates it) are left alone and
 * may be *removed*; only creating new ones is refused.
 *
 * Administrative objects carry no owner, so `own` and `team` would deny
 * everything and `all` is the only scope that means anything (see the note on
 * `INVITATION_GRANT` in the seed).
 */

export interface GrantCatalogueEntry {
  readonly objectType: ObjectType;
  /** `record` objects have owners and per-field rules; `administrative` ones do not. */
  readonly kind: 'record' | 'administrative';
  readonly actions: readonly Action[];
  readonly scopes: readonly Scope[];
}

const RECORD_SCOPES: readonly Scope[] = ['own', 'team', 'all'];
const ADMIN_SCOPES: readonly Scope[] = ['all'];

export const GRANT_CATALOGUE: readonly GrantCatalogueEntry[] = [
  {
    objectType: 'account',
    kind: 'record',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import'],
    scopes: RECORD_SCOPES,
  },
  {
    objectType: 'contact',
    kind: 'record',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import'],
    scopes: RECORD_SCOPES,
  },
  {
    objectType: 'lead',
    kind: 'record',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import'],
    scopes: RECORD_SCOPES,
  },
  {
    // Deals are importable since ADR-0070: a row names its pipeline and stage by name.
    objectType: 'deal',
    kind: 'record',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import'],
    scopes: RECORD_SCOPES,
  },
  {
    objectType: 'activity',
    kind: 'record',
    actions: ['read', 'create', 'update', 'delete'],
    scopes: RECORD_SCOPES,
  },
  {
    objectType: 'invitation',
    kind: 'administrative',
    actions: ['read', 'create', 'delete'],
    scopes: ADMIN_SCOPES,
  },
  {
    objectType: 'role',
    kind: 'administrative',
    actions: ['read', 'create', 'update', 'delete'],
    scopes: ADMIN_SCOPES,
  },
  {
    objectType: 'team',
    kind: 'administrative',
    actions: ['read', 'create', 'update', 'delete'],
    scopes: ADMIN_SCOPES,
  },
  {
    objectType: 'membership',
    kind: 'administrative',
    actions: ['read', 'update'],
    scopes: ADMIN_SCOPES,
  },
  // The M11 capabilities. ADR-0034 is explicit that these are granted as rows
  // like everything else, "visible in the permission matrix, editable without a
  // deploy" — which is true only if they are listed here, because the role
  // editor renders this catalogue and nothing else. The actions match the
  // system-role grants in `@crm/db`'s seed exactly: reading history and taking
  // a copy of it; exporting the whole workspace; and, for one person's data, the
  // three escalating steps of seeing it, taking it out, and erasing it.
  {
    objectType: 'audit_log',
    kind: 'administrative',
    actions: ['read', 'export'],
    scopes: ADMIN_SCOPES,
  },
  {
    objectType: 'tenant_data',
    kind: 'administrative',
    actions: ['export'],
    scopes: ADMIN_SCOPES,
  },
  {
    objectType: 'data_subject',
    kind: 'administrative',
    actions: ['read', 'export', 'delete'],
    scopes: ADMIN_SCOPES,
  },
  // Company profile, the setup checklist and sample data (MVP_SPEC M2). One type
  // rather than reusing `tenant_data`, which is about exporting a workspace's
  // contents: renaming the company is a far milder grant than taking a copy of
  // everything, and a single type would make the mild one carry the dangerous one.
  {
    objectType: 'tenant_settings',
    kind: 'administrative',
    actions: ['read', 'update'],
    scopes: ADMIN_SCOPES,
  },
  // The pipeline and stage editor (ADR-0062). `create` adds a stage, `update` renames,
  // reorders and re-weights, `delete` retires one (stages are never hard-deleted).
  {
    objectType: 'pipeline',
    kind: 'administrative',
    actions: ['read', 'create', 'update', 'delete'],
    scopes: ADMIN_SCOPES,
  },
  // Original dates on an import (ADR-0069). `create` is the one switch: a file may then carry the
  // date each record was really created. It is apart from `import` because it lets a record claim
  // a past that reports, ageing and "won this month" will then believe.
  {
    objectType: 'import_history',
    kind: 'administrative',
    actions: ['create'],
    scopes: ADMIN_SCOPES,
  },
];

export function catalogueEntry(objectType: ObjectType): GrantCatalogueEntry | undefined {
  return GRANT_CATALOGUE.find((entry) => entry.objectType === objectType);
}

/** Whether a grant of this scope may be **created**. Removing is always allowed. */
export function isGrantable(objectType: ObjectType, action: Action, scope: Scope): boolean {
  const entry = catalogueEntry(objectType);
  return entry !== undefined && entry.actions.includes(action) && entry.scopes.includes(scope);
}

export interface ProposedGrant {
  readonly objectType: ObjectType;
  readonly action: Action;
  readonly scope: Scope;
}

/**
 * The grants in `proposed` that reach further than `actor` does.
 *
 * An actor cannot hand out what they do not hold. Without this, anybody who
 * may edit roles could write themselves — or a role they then assign to
 * themselves — a wider scope than they were given, and `role:update` would be a
 * path to every other permission in the product. It is asked of the engine,
 * not of a role name: the answer is whatever `can()` says the actor may do
 * today, so it keeps working when an administrator builds a custom "People
 * manager" role.
 */
export function grantsBeyond(actor: Actor, proposed: readonly ProposedGrant[]): ProposedGrant[] {
  return proposed.filter((grant) => {
    const held = can(actor, grant.action, { objectType: grant.objectType }).derivation
      .effectiveScope;
    return held === null || scopeRank(held) < scopeRank(grant.scope);
  });
}
