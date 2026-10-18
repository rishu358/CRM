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
 * Runs inside a tenant-scoped transaction. Returns `null` when the user has no
 * active membership in the tenant, so the caller decides whether that is a 403
 * (a request) or a failed job (a worker); it is the same fact either way.
 */
export async function loadActor(tx: Tx, userId: string, tenantId: string): Promise<Actor | null> {
  const membership = (
    await tx.execute(sql`
      select role_id
      from memberships
      where user_id = ${userId}
        and tenant_id = ${tenantId}
        and status = 'active'
      limit 1
    `)
  ).rows as unknown as { role_id: string }[];

  const roleId = membership[0]?.role_id;
  if (roleId === undefined) return null;

  // Sequential, not Promise.all: a transaction is one connection, and issuing
  // concurrent queries on one pg client is deprecated.
  const grants = await tx.execute(sql`
    select role_id, object_type, action, scope
    from role_permissions
    where role_id = ${roleId}
  `);
  const fieldRules = await tx.execute(sql`
    select role_id, object_type, field_key, access
    from field_permissions
    where role_id = ${roleId}
  `);
  const teams = await tx.execute(sql`
    select team_id from team_members where user_id = ${userId}
  `);

  const rolePermissions = (
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

  const fieldPermissions = (
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

  return {
    userId: userId as Uuid,
    tenantId: tenantId as Uuid,
    teamIds: (teams.rows as unknown as { team_id: string }[]).map((row) => row.team_id as Uuid),
    permissions: compilePermissions(rolePermissions, fieldPermissions),
  } satisfies Actor;
}
