import { newId, type Uuid } from '../ids/index.js';
import type { Actor, FieldPermissionRow, PermissionSet, RolePermissionRow } from './types.js';
import { compilePermissions } from './compile.js';

/** Test-only helpers for assembling actors. Not exported from the package root. */

export function makePermissionSet(
  rolePermissions: readonly RolePermissionRow[],
  fieldPermissions: readonly FieldPermissionRow[] = [],
): PermissionSet {
  return compilePermissions(rolePermissions, fieldPermissions);
}

export function makeActor(options: {
  userId?: Uuid;
  tenantId?: Uuid;
  teamIds?: readonly Uuid[];
  rolePermissions?: readonly RolePermissionRow[];
  fieldPermissions?: readonly FieldPermissionRow[];
}): Actor {
  return {
    userId: options.userId ?? newId(),
    tenantId: options.tenantId ?? newId(),
    teamIds: options.teamIds ?? [],
    permissions: makePermissionSet(options.rolePermissions ?? [], options.fieldPermissions ?? []),
  };
}
