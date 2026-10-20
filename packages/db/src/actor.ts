import {
  compilePermissions,
  type Actor,
  type FieldPermissionRow,
  type RolePermissionRow,
  type Uuid,
} from '@crm/core';
import { sql } from 'drizzle-orm';
import type { Tx } from './client.js';

/**
 * Build the Actor `can()` reasons about, from the database (ADR-0008).
 *
 * Lives here, not in the API, because a second process has to do the same
 * thing: an import or an export runs in the worker, minutes after the request
 * that asked for it, and must be judged by what the user is allowed to do
 * **now**, not by what they were allowed to do when they clicked. A role
 * revoked between "start import" and the worker reaching the file takes effect
 * on the next chunk. Copying this query into the worker would give the two
 * processes two definitions of "may", which is how a permission fix ends up
 * applied in one and not the other.
 *
 * The access explainer is a third consumer (ADR-0033): to say who can see a
 * record it has to build every member's Actor, and it must build them **the
 * way a request does**. So there is one implementation, `loadActors`, and
 * `loadActor` is that for a single user. An explainer with its own copy of
 * this query would be a second description of who may do what.
 *
 * Runs inside a tenant-scoped transaction. Users without an active membership
 * in the tenant are simply absent from the result, so the caller decides
 * whether that is a 403 (a request) or a failed job (a worker); it is the same
 * fact either way.
 */
export async function loadActors(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, Actor>> {
  const actors = new Map<string, Actor>();
  if (userIds.length === 0) return actors;

  const ids = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const memberships = (
    await tx.execute(sql`
      select user_id, role_id
      from memberships
      where tenant_id = ${tenantId}
        and user_id in (${ids})
        and status = 'active'
    `)
  ).rows as unknown as { user_id: string; role_id: string }[];
  if (memberships.length === 0) return actors;

  const roleIds = [...new Set(memberships.map((row) => row.role_id))];
  const roleList = sql.join(
    roleIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // Sequential, not Promise.all: a transaction is one connection, and issuing
  // concurrent queries on one pg client is deprecated.
  const grants = await tx.execute(sql`
    select role_id, object_type, action, scope
    from role_permissions
    where tenant_id = ${tenantId} and role_id in (${roleList})
  `);
  const fieldRules = await tx.execute(sql`
    select role_id, object_type, field_key, access
    from field_permissions
    where tenant_id = ${tenantId} and role_id in (${roleList})
  `);
  const teams = await tx.execute(sql`
    select user_id, team_id
    from team_members
    where tenant_id = ${tenantId} and user_id in (${ids})
  `);

  const grantRows = (
    grants.rows as unknown as {
      role_id: string;
      object_type: string;
      action: string;
      scope: string;
    }[]
  ).map(
    (row) =>
      ({
        roleId: row.role_id,
        objectType: row.object_type,
        action: row.action,
        scope: row.scope,
      }) as RolePermissionRow,
  );

  const fieldRows = (
    fieldRules.rows as unknown as {
      role_id: string;
      object_type: string;
      field_key: string;
      access: string;
    }[]
  ).map(
    (row) =>
      ({
        roleId: row.role_id,
        objectType: row.object_type,
        fieldKey: row.field_key,
        access: row.access,
      }) as FieldPermissionRow,
  );

  const teamsByUser = new Map<string, Uuid[]>();
  for (const row of teams.rows as unknown as { user_id: string; team_id: string }[]) {
    const list = teamsByUser.get(row.user_id) ?? [];
    list.push(row.team_id as Uuid);
    teamsByUser.set(row.user_id, list);
  }

  for (const membership of memberships) {
    actors.set(membership.user_id, {
      userId: membership.user_id as Uuid,
      tenantId: tenantId as Uuid,
      teamIds: teamsByUser.get(membership.user_id) ?? [],
      permissions: compilePermissions(
        grantRows.filter((row) => row.roleId === membership.role_id),
        fieldRows.filter((row) => row.roleId === membership.role_id),
      ),
    } satisfies Actor);
  }
  return actors;
}

export async function loadActor(tx: Tx, userId: string, tenantId: string): Promise<Actor | null> {
  return (await loadActors(tx, tenantId, [userId])).get(userId) ?? null;
}
