import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * Roles, grants and teams — the data `can()` compiles (ADR-0008).
 *
 * All tenant-owned and RLS-protected: a tenant must never read, let alone edit,
 * another tenant's permission configuration.
 */

export const roles = pgTable(
  'roles',
  {
    ...baseColumns,
    name: text('name').notNull(),
    description: text('description'),
    /** System roles are seeded for every tenant and cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
  },
  (table) => [uniqueIndex('roles_tenant_name_key').on(table.tenantId, table.name)],
);

/**
 * One grant: this role may perform this action on this object type, at this scope.
 *
 * Absence of a row is a denial — there is no explicit deny, because mixing allow
 * and deny rules makes the effective permission impossible to reason about once
 * a user holds several roles.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    ...baseColumns,
    roleId: uuid('role_id').notNull(),
    objectType: text('object_type').notNull(),
    /** read | create | update | delete | export | import */
    action: text('action').notNull(),
    /** own | team | all */
    scope: text('scope').notNull(),
  },
  (table) => [
    uniqueIndex('role_permissions_unique').on(
      table.tenantId,
      table.roleId,
      table.objectType,
      table.action,
    ),
    index('role_permissions_tenant_role_idx').on(table.tenantId, table.roleId),
  ],
);

/**
 * Field-level overrides. Only ever narrows what the object-level grant allows
 * (see `accessForRole` in @crm/core/permissions).
 */
export const fieldPermissions = pgTable(
  'field_permissions',
  {
    ...baseColumns,
    roleId: uuid('role_id').notNull(),
    objectType: text('object_type').notNull(),
    fieldKey: text('field_key').notNull(),
    /** hidden | read | write */
    access: text('access').notNull(),
  },
  (table) => [
    uniqueIndex('field_permissions_unique').on(
      table.tenantId,
      table.roleId,
      table.objectType,
      table.fieldKey,
    ),
    index('field_permissions_tenant_role_idx').on(table.tenantId, table.roleId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    ...baseColumns,
    name: text('name').notNull(),
    /** Self-referencing hierarchy; territories build on this in P2. */
    parentTeamId: uuid('parent_team_id'),
  },
  (table) => [
    uniqueIndex('teams_tenant_name_key').on(table.tenantId, table.name),
    index('teams_tenant_parent_idx').on(table.tenantId, table.parentTeamId),
  ],
);

export const teamMembers = pgTable(
  'team_members',
  {
    ...baseColumns,
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    uniqueIndex('team_members_unique').on(table.tenantId, table.teamId, table.userId),
    index('team_members_tenant_user_idx').on(table.tenantId, table.userId),
  ],
);

export type Role = typeof roles.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type FieldPermission = typeof fieldPermissions.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
