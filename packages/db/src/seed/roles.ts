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
 * `role:read` is also the gate on the access explainer (ADR-0033). That is
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

/**
 * Reading history, and acting on data-protection rights (MVP_SPEC M11).
 *
 * Capabilities, not records, so `all` is the only scope that means anything on
 * them — exactly like `invitation` above. Granted deliberately narrowly:
 *
 *   - `audit_log` read and export go to **Owner and Admin**, the two personas
 *     MVP_SPEC §4 describes as responsible for security settings. Nobody else
 *     reaches the viewer at all, because the absence of a row is a denial.
 *   - `tenant_data` export — the whole workspace in one archive — goes to the
 *     **Owner alone**, as MVP_SPEC M11 says. It is the single most dangerous
 *     read in the product.
 *   - `data_subject` read and export (answering "send me my data") go to Owner
 *     and Admin, because handling a subject access request is day-to-day work.
 *     `delete` — erasure — goes to the Owner alone: it is irreversible, it
 *     reaches into the append-only audit log, and ADR-0032 is explicit that the
 *     narrow privileged path it opens should be reachable by as few people as
 *     possible.
 */
const AUDIT_LOG_GRANT: SystemRoleGrant = {
  objectType: 'audit_log',
  actions: ['read', 'export'],
  scope: 'all',
};

const DATA_SUBJECT_READ_GRANT: SystemRoleGrant = {
  objectType: 'data_subject',
  actions: ['read', 'export'],
  scope: 'all',
};

const DATA_SUBJECT_ERASE_GRANT: SystemRoleGrant = {
  objectType: 'data_subject',
  actions: ['read', 'export', 'delete'],
  scope: 'all',
};

/**
 * Company profile, the setup checklist and sample data (MVP_SPEC M2).
 *
 * Owner and Admin, like the rest of workspace administration: they are the two
 * personas MVP_SPEC §4 describes as setting the company up. Migration 0017
 * backfills the same rows for tenants that already exist.
 */
const TENANT_SETTINGS_GRANT: SystemRoleGrant = {
  objectType: 'tenant_settings',
  actions: ['read', 'update'],
  scope: 'all',
};

/**
 * The pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
 *
 * Owner and Admin, like the other company-wide configuration. Migration 0024
 * backfills the same rows for tenants that already exist. A custom role gets
 * nothing: the editor is an explicit grant.
 */
const PIPELINE_GRANT: SystemRoleGrant = {
  objectType: 'pipeline',
  actions: ['read', 'create', 'update', 'delete'],
  scope: 'all',
};

/**
 * Original dates on an import (ADR-0069): a file may set when each record was really created.
 *
 * Owner and Admin only, by the owner's decision (2026-10-28). Migration 0030 backfills the same rows
 * for tenants that already exist. A custom role gets nothing: it is an explicit grant.
 */
const IMPORT_HISTORY_GRANT: SystemRoleGrant = {
  objectType: 'import_history',
  actions: ['create'],
  scope: 'all',
};

/**
 * Website lead forms (ADR-0065): creating a form, changing it, rotating its key, switching it off.
 *
 * Owner and Admin, like the other company-wide configuration. Migration 0027 backfills the same
 * rows for tenants that already exist. A custom role gets nothing.
 */
const LEAD_FORM_GRANT: SystemRoleGrant = {
  objectType: 'lead_form',
  actions: ['read', 'create', 'update', 'delete'],
  scope: 'all',
};

/**
 * The assignment rules (ADR-0065 10). Owner and Admin; migration 0028 backfills the same rows.
 */
const LEAD_ASSIGNMENT_GRANT: SystemRoleGrant = {
  objectType: 'lead_assignment',
  actions: ['read', 'create', 'update', 'delete'],
  scope: 'all',
};

/**
 * Sending email from a record, and reading the emails on the records one can see (ADR-0073).
 *
 * Owner, Admin, Manager and Sales Rep; Read-only gets none, because an email body is a conversation
 * with a customer and not a field. The grant says nothing about *which* records: every use is paired
 * with the ordinary read check on the record at the person's own scope. Migration 0032 backfills the
 * same rows for tenants that already exist. A custom role gets nothing.
 */
const EMAIL_MESSAGE_GRANT: SystemRoleGrant = {
  objectType: 'email_message',
  actions: ['read', 'create'],
  scope: 'all',
};

const TENANT_DATA_GRANT: SystemRoleGrant = {
  objectType: 'tenant_data',
  actions: ['export'],
  scope: 'all',
};

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    name: 'Owner',
    description: 'Full control of the company account, including billing and security settings.',
    grants: [
      ...grantsFor(ALL_ACTIONS, 'all'),
      INVITATION_GRANT,
      ...ADMINISTRATION_GRANTS,
      AUDIT_LOG_GRANT,
      TENANT_DATA_GRANT,
      DATA_SUBJECT_ERASE_GRANT,
      TENANT_SETTINGS_GRANT,
      PIPELINE_GRANT,
      IMPORT_HISTORY_GRANT,
      LEAD_FORM_GRANT,
      LEAD_ASSIGNMENT_GRANT,
      EMAIL_MESSAGE_GRANT,
    ],
  },
  {
    name: 'Admin',
    description: 'Manages users, roles and customization. Sees all records.',
    grants: [
      ...grantsFor(ALL_ACTIONS, 'all'),
      INVITATION_GRANT,
      ...ADMINISTRATION_GRANTS,
      AUDIT_LOG_GRANT,
      DATA_SUBJECT_READ_GRANT,
      TENANT_SETTINGS_GRANT,
      PIPELINE_GRANT,
      IMPORT_HISTORY_GRANT,
      LEAD_FORM_GRANT,
      LEAD_ASSIGNMENT_GRANT,
      EMAIL_MESSAGE_GRANT,
    ],
  },
  {
    name: 'Manager',
    description: "Sees and manages the team's records, and can reassign work.",
    grants: [
      ...grantsFor(['read', 'create', 'update', 'delete', 'export', 'import'], 'team'),
      EMAIL_MESSAGE_GRANT,
    ],
  },
  {
    name: 'Sales Rep',
    description: 'Works their own records. Cannot see other reps’ books.',
    grants: [...grantsFor(['read', 'create', 'update', 'export'], 'own'), EMAIL_MESSAGE_GRANT],
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
