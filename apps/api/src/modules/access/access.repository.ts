import { Injectable } from '@nestjs/common';
import {
  newId,
  type Action,
  type FieldAccess,
  type FieldRuleCell,
  type GrantCell,
  type ObjectType,
  type PermissionState,
  type Scope,
} from '@crm/core';
import type { Tx } from '@crm/db';
import { sql } from 'drizzle-orm';

/**
 * Persistence for roles, members and teams (MVP_SPEC M3).
 *
 * Every statement filters on `tenant_id` explicitly **and** runs under RLS, so
 * a role, team or user id from another workspace reads as absent either way.
 * Plain parameterized SQL throughout: the reads here are aggregates and joins
 * that an ORM would only obscure, and nothing in this file interpolates a
 * request value into a name (CLAUDE.md §5.7).
 *
 * Not exported from the module (CLAUDE.md §3). Other modules ask this one
 * through its services.
 */

export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly memberCount: number;
  readonly grantCount: number;
}

export interface MemberRow {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly status: 'active' | 'suspended';
  readonly joinedAt: Date | null;
}

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly parentTeamId: string | null;
}

export interface TeamMemberRow {
  readonly teamId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

type Raw = Record<string, unknown>;

function rows(result: { rows: unknown[] }): Raw[] {
  return result.rows as Raw[];
}

@Injectable()
export class AccessRepository {
  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  async listRoles(tx: Tx, tenantId: string): Promise<RoleRow[]> {
    const result = await tx.execute(sql`
      select r.id, r.name, r.description, r.is_system,
        (select count(*)::int from memberships m
          where m.tenant_id = r.tenant_id and m.role_id = r.id) as member_count,
        (select count(*)::int from role_permissions p
          where p.tenant_id = r.tenant_id and p.role_id = r.id) as grant_count
      from roles r
      where r.tenant_id = ${tenantId}::uuid
      order by r.is_system desc, lower(r.name), r.id
    `);
    return rows(result).map(toRoleRow);
  }

  async findRole(tx: Tx, tenantId: string, id: string): Promise<RoleRow | null> {
    const result = await tx.execute(sql`
      select r.id, r.name, r.description, r.is_system,
        (select count(*)::int from memberships m
          where m.tenant_id = r.tenant_id and m.role_id = r.id) as member_count,
        (select count(*)::int from role_permissions p
          where p.tenant_id = r.tenant_id and p.role_id = r.id) as grant_count
      from roles r
      where r.tenant_id = ${tenantId}::uuid and r.id = ${id}::uuid
    `);
    const row = rows(result)[0];
    return row === undefined ? null : toRoleRow(row);
  }

  /** The role's cells. Lock the role row first when the result is about to be edited. */
  async loadPermissionState(tx: Tx, tenantId: string, roleId: string): Promise<PermissionState> {
    const grants = await tx.execute(sql`
      select object_type, action, scope from role_permissions
      where tenant_id = ${tenantId}::uuid and role_id = ${roleId}::uuid
    `);
    const rules = await tx.execute(sql`
      select object_type, field_key, access from field_permissions
      where tenant_id = ${tenantId}::uuid and role_id = ${roleId}::uuid
    `);
    return {
      grants: rows(grants).map((row): GrantCell => ({
        objectType: row['object_type'] as ObjectType,
        action: row['action'] as Action,
        scope: row['scope'] as Scope,
      })),
      fieldRules: rows(rules).map((row): FieldRuleCell => ({
        objectType: row['object_type'] as ObjectType,
        fieldKey: row['field_key'] as string,
        access: row['access'] as FieldAccess,
      })),
    };
  }

  /**
   * Serialise concurrent edits of one role.
   *
   * Two administrators saving at once would otherwise each read the digest, each
   * pass the check, and each write — the second silently overwriting what the
   * first previewed. The lock makes the digest check and the write one step.
   */
  async lockRole(tx: Tx, tenantId: string, roleId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      select id from roles
      where tenant_id = ${tenantId}::uuid and id = ${roleId}::uuid
      for update
    `);
    return rows(result).length > 0;
  }

  /**
   * Serialise every change that could remove the last administrator.
   *
   * "Somebody can still manage roles and members" is checked after a write and
   * before the commit, which on its own is a race: two administrators demoting
   * each other at the same moment each see the other still in place, each pass,
   * and both commit. A transaction-scoped advisory lock keyed on the workspace
   * makes the second one wait and then see the first's result. It is released
   * with the transaction, so nothing can leave it held.
   */
  async lockAdministration(tx: Tx, tenantId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'access-administration:' + tenantId}::text, 0))`,
    );
  }

  async insertRole(
    tx: Tx,
    values: { tenantId: string; name: string; description: string | null; createdBy: string },
  ): Promise<string> {
    const id = newId();
    await tx.execute(sql`
      insert into roles (id, tenant_id, name, description, is_system, created_by, updated_by)
      values (${id}::uuid, ${values.tenantId}::uuid, ${values.name}, ${values.description},
              false, ${values.createdBy}::uuid, ${values.createdBy}::uuid)
    `);
    return id;
  }

  async updateRole(
    tx: Tx,
    tenantId: string,
    id: string,
    patch: { name?: string; description?: string | null },
    updatedBy: string,
  ): Promise<void> {
    await tx.execute(sql`
      update roles set
        name = coalesce(${patch.name ?? null}::text, name),
        description = case when ${patch.description !== undefined}::boolean then ${patch.description ?? null}::text
                           else description end,
        updated_at = now(), updated_by = ${updatedBy}::uuid
      where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
    `);
  }

  async deleteRole(tx: Tx, tenantId: string, id: string): Promise<void> {
    await tx.execute(sql`
      delete from roles where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
    `);
  }

  async upsertGrant(
    tx: Tx,
    tenantId: string,
    roleId: string,
    cell: GrantCell,
    by: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into role_permissions (id, tenant_id, role_id, object_type, action, scope,
                                    created_by, updated_by)
      values (${newId()}::uuid, ${tenantId}::uuid, ${roleId}::uuid, ${cell.objectType},
              ${cell.action}, ${cell.scope}, ${by}::uuid, ${by}::uuid)
      on conflict (tenant_id, role_id, object_type, action)
      do update set scope = excluded.scope, updated_at = now(), updated_by = excluded.updated_by
    `);
  }

  async deleteGrant(
    tx: Tx,
    tenantId: string,
    roleId: string,
    objectType: string,
    action: string,
  ): Promise<void> {
    await tx.execute(sql`
      delete from role_permissions
      where tenant_id = ${tenantId}::uuid and role_id = ${roleId}::uuid
        and object_type = ${objectType} and action = ${action}
    `);
  }

  async upsertFieldRule(
    tx: Tx,
    tenantId: string,
    roleId: string,
    cell: FieldRuleCell,
    by: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into field_permissions (id, tenant_id, role_id, object_type, field_key, access,
                                     created_by, updated_by)
      values (${newId()}::uuid, ${tenantId}::uuid, ${roleId}::uuid, ${cell.objectType},
              ${cell.fieldKey}, ${cell.access}, ${by}::uuid, ${by}::uuid)
      on conflict (tenant_id, role_id, object_type, field_key)
      do update set access = excluded.access, updated_at = now(), updated_by = excluded.updated_by
    `);
  }

  async deleteFieldRule(
    tx: Tx,
    tenantId: string,
    roleId: string,
    objectType: string,
    fieldKey: string,
  ): Promise<void> {
    await tx.execute(sql`
      delete from field_permissions
      where tenant_id = ${tenantId}::uuid and role_id = ${roleId}::uuid
        and object_type = ${objectType} and field_key = ${fieldKey}
    `);
  }

  /** Active field keys per object, for validating a field rule against real metadata. */
  async activeFieldKeys(tx: Tx, tenantId: string): Promise<Map<string, Map<string, string>>> {
    const result = await tx.execute(sql`
      select object_type, key, label from field_definitions
      where tenant_id = ${tenantId}::uuid and is_active
      order by position, key
    `);
    const map = new Map<string, Map<string, string>>();
    for (const row of rows(result)) {
      const objectType = row['object_type'] as string;
      const fields = map.get(objectType) ?? new Map<string, string>();
      fields.set(row['key'] as string, row['label'] as string);
      map.set(objectType, fields);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async listMembers(
    tx: Tx,
    tenantId: string,
    status: 'active' | 'suspended' | undefined,
    limit: number,
  ): Promise<MemberRow[]> {
    const result = await tx.execute(sql`
      select m.user_id, u.name, u.email, m.role_id, r.name as role_name, m.status, m.joined_at
      from memberships m
      join users u on u.id = m.user_id
      join roles r on r.id = m.role_id and r.tenant_id = m.tenant_id
      where m.tenant_id = ${tenantId}::uuid
        and m.status in ('active', 'suspended')
        ${status === undefined ? sql`` : sql`and m.status = ${status}`}
      order by lower(u.name), m.user_id
      limit ${limit}
    `);
    return rows(result).map(toMemberRow);
  }

  /**
   * Display names of active members, for the ids asked about and nobody else.
   *
   * Names only: no address, role or status leaves through here, so a screen that
   * needs to say whose number it is showing can do so without becoming a member
   * directory (ADR-0038).
   */
  async activeMemberNames(
    tx: Tx,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const result = await tx.execute(sql`
      select m.user_id, u.name
      from memberships m
      join users u on u.id = m.user_id
      where m.tenant_id = ${tenantId}::uuid
        and m.status = 'active'
        and m.user_id in (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `);
    return new Map(rows(result).map((row) => [String(row.user_id), String(row.name)] as const));
  }

  /**
   * Which of these people may own a record of this type: an active member, not deleted, whose role
   * grants both `read` and `update` on it (any scope). A person who could not open and work a lead
   * must not be given one (ADR-0065 10). An empty candidate list means nobody is asked about.
   */
  async membersWhoCanWork(
    tx: Tx,
    tenantId: string,
    objectType: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const result = await tx.execute(sql`
      select m.user_id
      from memberships m
      join users u on u.id = m.user_id
      where m.tenant_id = ${tenantId}::uuid
        and m.status = 'active'
        and u.deleted_at is null
        and m.user_id in (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        and (
          select count(distinct rp.action)
          from role_permissions rp
          where rp.tenant_id = m.tenant_id
            and rp.role_id = m.role_id
            and rp.object_type = ${objectType}
            and rp.action in ('read', 'update')
        ) = 2
    `);
    return rows(result).map((row) => String(row.user_id));
  }

  /**
   * The longest-standing active member whose role holds this capability, and who can also work
   * leads. A capability and not a role name: no role is ever recognised by what it is called
   * (CLAUDE.md §5.3).
   */
  async earliestMemberWith(
    tx: Tx,
    tenantId: string,
    capability: { readonly objectType: string; readonly action: string },
  ): Promise<string | null> {
    const result = await tx.execute(sql`
      select m.user_id
      from memberships m
      join users u on u.id = m.user_id
      where m.tenant_id = ${tenantId}::uuid
        and m.status = 'active'
        and u.deleted_at is null
        and exists (
          select 1 from role_permissions rp
          where rp.tenant_id = m.tenant_id and rp.role_id = m.role_id
            and rp.object_type = ${capability.objectType} and rp.action = ${capability.action}
        )
        and (
          select count(distinct rp.action) from role_permissions rp
          where rp.tenant_id = m.tenant_id and rp.role_id = m.role_id
            and rp.object_type = 'lead' and rp.action in ('read', 'update')
        ) = 2
      order by coalesce(m.joined_at, m.created_at), m.user_id
      limit 1
    `);
    const row = rows(result)[0];
    return row === undefined ? null : String(row.user_id);
  }

  async findMember(tx: Tx, tenantId: string, userId: string): Promise<MemberRow | null> {
    const result = await tx.execute(sql`
      select m.user_id, u.name, u.email, m.role_id, r.name as role_name, m.status, m.joined_at
      from memberships m
      join users u on u.id = m.user_id
      join roles r on r.id = m.role_id and r.tenant_id = m.tenant_id
      where m.tenant_id = ${tenantId}::uuid and m.user_id = ${userId}::uuid
        and m.status in ('active', 'suspended')
    `);
    const row = rows(result)[0];
    return row === undefined ? null : toMemberRow(row);
  }

  /** The ids of everyone in the workspace who can currently act. */
  async activeMemberIds(tx: Tx, tenantId: string): Promise<string[]> {
    const result = await tx.execute(sql`
      select user_id from memberships
      where tenant_id = ${tenantId}::uuid and status = 'active'
    `);
    return rows(result).map((row) => row['user_id'] as string);
  }

  async activeMembersOfRole(
    tx: Tx,
    tenantId: string,
    roleId: string,
  ): Promise<{ userId: string; name: string; email: string }[]> {
    const result = await tx.execute(sql`
      select m.user_id, u.name, u.email
      from memberships m join users u on u.id = m.user_id
      where m.tenant_id = ${tenantId}::uuid and m.role_id = ${roleId}::uuid
        and m.status = 'active'
      order by lower(u.name), m.user_id
    `);
    return rows(result).map((row) => ({
      userId: row['user_id'] as string,
      name: row['name'] as string,
      email: row['email'] as string,
    }));
  }

  async updateMembership(
    tx: Tx,
    tenantId: string,
    userId: string,
    patch: { roleId?: string; status?: 'active' | 'suspended' },
    updatedBy: string,
  ): Promise<void> {
    await tx.execute(sql`
      update memberships set
        role_id = coalesce(${patch.roleId ?? null}::uuid, role_id),
        status = coalesce(${patch.status ?? null}::text, status),
        updated_at = now(), updated_by = ${updatedBy}::uuid
      where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid
    `);
  }

  /** Name and email for a set of users already known to belong to this workspace. */
  async userNames(
    tx: Tx,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, { name: string; email: string }>> {
    const map = new Map<string, { name: string; email: string }>();
    if (userIds.length === 0) return map;
    const result = await tx.execute(sql`
      select u.id, u.name, u.email
      from users u
      join memberships m on m.user_id = u.id and m.tenant_id = ${tenantId}::uuid
      where u.id in (${sql.join(
        userIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
    for (const row of rows(result)) {
      map.set(row['id'] as string, { name: row['name'] as string, email: row['email'] as string });
    }
    return map;
  }

  /** Which of these users have a membership here, in any state. */
  async existingMemberIds(
    tx: Tx,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const result = await tx.execute(sql`
      select user_id from memberships
      where tenant_id = ${tenantId}::uuid
        and status in ('active', 'suspended')
        and user_id in (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `);
    return new Set(rows(result).map((row) => row['user_id'] as string));
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------

  async listTeams(tx: Tx, tenantId: string): Promise<TeamRow[]> {
    const result = await tx.execute(sql`
      select id, name, parent_team_id from teams
      where tenant_id = ${tenantId}::uuid
      order by lower(name), id
    `);
    return rows(result).map(toTeamRow);
  }

  async findTeam(tx: Tx, tenantId: string, id: string): Promise<TeamRow | null> {
    const result = await tx.execute(sql`
      select id, name, parent_team_id from teams
      where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
    `);
    const row = rows(result)[0];
    return row === undefined ? null : toTeamRow(row);
  }

  async teamMembers(
    tx: Tx,
    tenantId: string,
    teamIds?: readonly string[],
  ): Promise<TeamMemberRow[]> {
    const filter =
      teamIds === undefined
        ? sql``
        : teamIds.length === 0
          ? sql`and false`
          : sql`and tm.team_id in (${sql.join(
              teamIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`;
    const result = await tx.execute(sql`
      select tm.team_id, tm.user_id, u.name, u.email
      from team_members tm join users u on u.id = tm.user_id
      where tm.tenant_id = ${tenantId}::uuid ${filter}
      order by lower(u.name), tm.user_id
    `);
    return rows(result).map((row) => ({
      teamId: row['team_id'] as string,
      userId: row['user_id'] as string,
      name: row['name'] as string,
      email: row['email'] as string,
    }));
  }

  async insertTeam(
    tx: Tx,
    values: { tenantId: string; name: string; parentTeamId: string | null; createdBy: string },
  ): Promise<string> {
    const id = newId();
    await tx.execute(sql`
      insert into teams (id, tenant_id, name, parent_team_id, created_by, updated_by)
      values (${id}::uuid, ${values.tenantId}::uuid, ${values.name}, ${values.parentTeamId}::uuid,
              ${values.createdBy}::uuid, ${values.createdBy}::uuid)
    `);
    return id;
  }

  async updateTeam(
    tx: Tx,
    tenantId: string,
    id: string,
    patch: { name?: string; parentTeamId?: string | null },
    updatedBy: string,
  ): Promise<void> {
    await tx.execute(sql`
      update teams set
        name = coalesce(${patch.name ?? null}::text, name),
        parent_team_id = case when ${patch.parentTeamId !== undefined}::boolean
                              then ${patch.parentTeamId ?? null}::uuid else parent_team_id end,
        updated_at = now(), updated_by = ${updatedBy}::uuid
      where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
    `);
  }

  async deleteTeam(tx: Tx, tenantId: string, id: string): Promise<void> {
    await tx.execute(sql`
      delete from teams where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
    `);
  }

  async replaceTeamMembers(
    tx: Tx,
    tenantId: string,
    teamId: string,
    userIds: readonly string[],
    by: string,
  ): Promise<void> {
    await tx.execute(sql`
      delete from team_members where tenant_id = ${tenantId}::uuid and team_id = ${teamId}::uuid
    `);
    for (const userId of userIds) {
      await tx.execute(sql`
        insert into team_members (id, tenant_id, team_id, user_id, created_by, updated_by)
        values (${newId()}::uuid, ${tenantId}::uuid, ${teamId}::uuid, ${userId}::uuid,
                ${by}::uuid, ${by}::uuid)
      `);
    }
  }

  /** The chain of parents above a team, nearest first — for refusing a cycle. */
  async ancestorIds(tx: Tx, tenantId: string, teamId: string): Promise<string[]> {
    const result = await tx.execute(sql`
      with recursive chain as (
        select id, parent_team_id, 1 as depth from teams
        where tenant_id = ${tenantId}::uuid and id = ${teamId}::uuid
        union all
        select t.id, t.parent_team_id, c.depth + 1
        from teams t join chain c on t.id = c.parent_team_id
        where t.tenant_id = ${tenantId}::uuid and c.depth < 64
      )
      select id from chain
    `);
    return rows(result).map((row) => row['id'] as string);
  }
}

function toRoleRow(row: Raw): RoleRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: (row['description'] as string | null) ?? null,
    isSystem: row['is_system'] as boolean,
    memberCount: row['member_count'] as number,
    grantCount: row['grant_count'] as number,
  };
}

function toMemberRow(row: Raw): MemberRow {
  return {
    userId: row['user_id'] as string,
    name: row['name'] as string,
    email: row['email'] as string,
    roleId: row['role_id'] as string,
    roleName: row['role_name'] as string,
    status: row['status'] as 'active' | 'suspended',
    joinedAt: row['joined_at'] === null ? null : new Date(row['joined_at'] as string),
  };
}

function toTeamRow(row: Raw): TeamRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    parentTeamId: (row['parent_team_id'] as string | null) ?? null,
  };
}
