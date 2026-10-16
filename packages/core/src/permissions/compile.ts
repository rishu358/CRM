import type { Action, ObjectType, Scope } from '../objects/index.js';
import { widestScope } from '../objects/index.js';
import type {
  CompiledRole,
  FieldAccess,
  FieldPermissionRow,
  PermissionSet,
  RolePermissionRow,
} from './types.js';
import { FIELD_ACCESS_RANK } from './types.js';

export function grantKey(objectType: ObjectType, action: Action): string {
  return `${objectType}:${action}`;
}

export function fieldKeyOf(objectType: ObjectType, fieldKey: string): string {
  return `${objectType}:${fieldKey}`;
}

/**
 * Compile raw permission rows into the lookup structure `can()` uses.
 *
 * Done once per request. `can()` is called on every endpoint and, for list
 * responses, once per field per row, so it must not be doing array scans.
 *
 * Within a single role, duplicate grants collapse to the **widest** scope and
 * duplicate field overrides collapse to the **most restrictive** access: a role
 * that is handed conflicting rows should end up with the safer field reading,
 * while its record reach is simply the union of what it was granted.
 */
export function compilePermissions(
  rolePermissions: readonly RolePermissionRow[],
  fieldPermissions: readonly FieldPermissionRow[],
): PermissionSet {
  const grantsByRole = new Map<string, Map<string, Scope>>();
  const fieldsByRole = new Map<string, Map<string, FieldAccess>>();
  const roleIds: string[] = [];

  const ensureRole = (roleId: string): void => {
    if (!grantsByRole.has(roleId)) {
      grantsByRole.set(roleId, new Map());
      fieldsByRole.set(roleId, new Map());
      roleIds.push(roleId);
    }
  };

  for (const row of rolePermissions) {
    ensureRole(row.roleId);
    const grants = grantsByRole.get(row.roleId)!;
    const key = grantKey(row.objectType, row.action);
    const existing = grants.get(key);
    grants.set(key, existing ? widestScope(existing, row.scope) : row.scope);
  }

  for (const row of fieldPermissions) {
    ensureRole(row.roleId);
    const fields = fieldsByRole.get(row.roleId)!;
    const key = fieldKeyOf(row.objectType, row.fieldKey);
    const existing = fields.get(key);
    const narrower =
      existing && FIELD_ACCESS_RANK[existing] < FIELD_ACCESS_RANK[row.access]
        ? existing
        : row.access;
    fields.set(key, narrower);
  }

  const roles: CompiledRole[] = roleIds.map((roleId) => ({
    roleId: roleId as CompiledRole['roleId'],
    grants: grantsByRole.get(roleId)!,
    fieldOverrides: fieldsByRole.get(roleId)!,
  }));

  return { roles };
}

/** An actor with no roles at all. Denied everything, by construction. */
export const EMPTY_PERMISSION_SET: PermissionSet = { roles: [] };
