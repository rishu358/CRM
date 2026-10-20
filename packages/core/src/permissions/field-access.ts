import { FieldNotWritableError } from '../errors/index.js';
import type { ObjectType } from '../objects/index.js';
import { fieldKeyOf, grantKey } from './compile.js';
import type { Actor, CompiledRole, FieldAccess } from './types.js';
import { FIELD_ACCESS_RANK } from './types.js';

function narrower(a: FieldAccess, b: FieldAccess): FieldAccess {
  return FIELD_ACCESS_RANK[a] <= FIELD_ACCESS_RANK[b] ? a : b;
}

function wider(a: FieldAccess, b: FieldAccess): FieldAccess {
  return FIELD_ACCESS_RANK[a] >= FIELD_ACCESS_RANK[b] ? a : b;
}

/**
 * What a single role can do with a field, and how it got there.
 *
 * The base comes from the role's object-level grant: a role that cannot read the
 * object cannot read any of its fields, and a role that can only read it cannot
 * write any of them. A `field_permissions` row then **narrows** that base.
 *
 * Field permissions can only restrict, never widen. Otherwise a stray field row
 * would hand out write access to an object the role was never granted, and
 * field-level configuration would become a way around object-level permissions.
 *
 * `base` and `override` are reported alongside `access` so the explainer can
 * say *which* of the two concealed a field — "her role cannot read contacts at
 * all" and "her role hides this one field" are different problems with
 * different fixes, and an administrator needs to be told which one they have
 * (ADR-0031). They are a description of this evaluation, not a second one.
 */
export interface RoleFieldAccess {
  readonly roleId: CompiledRole['roleId'];
  /** What this role ends up allowing. */
  readonly access: FieldAccess;
  /** What the object-level grant alone allowed, before any field rule. */
  readonly base: FieldAccess;
  /** The `field_permissions` row that applied, if there was one. */
  readonly override: FieldAccess | undefined;
}

function accessForRole(
  role: CompiledRole,
  objectType: ObjectType,
  fieldKey: string,
): RoleFieldAccess {
  const canWrite = role.grants.has(grantKey(objectType, 'update'));
  const canRead = role.grants.has(grantKey(objectType, 'read'));

  const base: FieldAccess = canWrite ? 'write' : canRead ? 'read' : 'hidden';
  const override = role.fieldOverrides.get(fieldKeyOf(objectType, fieldKey));

  if (base === 'hidden') return { roleId: role.roleId, access: 'hidden', base, override };

  return {
    roleId: role.roleId,
    access: override === undefined ? base : narrower(override, base),
    base,
    override,
  };
}

/**
 * The actor's effective access to one field.
 *
 * Union across the actor's roles, matching how object grants combine in `can()`:
 * holding an extra role never takes access away.
 *
 * This runs once per field per row of every list response, so it keeps its
 * early exit and allocates nothing. `fieldAccessDerivation` is the same
 * reduction over the same `accessForRole`, kept separate so the explainer's
 * bookkeeping is not paid for on the serialization path; a test asserts the two
 * agree on every combination.
 */
export function fieldAccess(actor: Actor, objectType: ObjectType, fieldKey: string): FieldAccess {
  let effective: FieldAccess = 'hidden';
  for (const role of actor.permissions.roles) {
    effective = wider(effective, accessForRole(role, objectType, fieldKey).access);
    if (effective === 'write') break;
  }
  return effective;
}

/** The actor's access to one field, with the per-role workings (ADR-0031). */
export interface FieldAccessDerivation {
  readonly fieldKey: string;
  readonly access: FieldAccess;
  /** Every role the actor holds, and what each allows on this field. */
  readonly roles: readonly RoleFieldAccess[];
  /** The first role granting the effective access — the one that decides. */
  readonly decidingRoleId: CompiledRole['roleId'] | null;
}

export function fieldAccessDerivation(
  actor: Actor,
  objectType: ObjectType,
  fieldKey: string,
): FieldAccessDerivation {
  const roles = actor.permissions.roles.map((role) => accessForRole(role, objectType, fieldKey));

  let access: FieldAccess = 'hidden';
  let decidingRoleId: CompiledRole['roleId'] | null = null;
  for (const role of roles) {
    if (FIELD_ACCESS_RANK[role.access] > FIELD_ACCESS_RANK[access]) {
      access = role.access;
      decidingRoleId = role.roleId;
    }
  }

  return { fieldKey, access, roles, decidingRoleId };
}

export function canReadField(actor: Actor, objectType: ObjectType, fieldKey: string): boolean {
  return FIELD_ACCESS_RANK[fieldAccess(actor, objectType, fieldKey)] >= FIELD_ACCESS_RANK.read;
}

export function canWriteField(actor: Actor, objectType: ObjectType, fieldKey: string): boolean {
  return fieldAccess(actor, objectType, fieldKey) === 'write';
}

/**
 * Remove fields the actor may not read (CLAUDE.md §5.4).
 *
 * This runs in the serializer, so it is the **last** thing between the database
 * and the response body. Every read path — record page, list view, search
 * results, export, audit diff — must pass through here, or a hidden field leaks
 * on whichever path forgot.
 *
 * Returns a new object; the input is never mutated.
 */
export function stripHiddenFields<T extends Record<string, unknown>>(
  actor: Actor,
  objectType: ObjectType,
  record: T,
): Partial<T> {
  const visible: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (canReadField(actor, objectType, key)) {
      visible[key] = record[key];
    }
  }
  return visible as Partial<T>;
}

/** Apply `stripHiddenFields` across a list. */
export function stripHiddenFieldsFromAll<T extends Record<string, unknown>>(
  actor: Actor,
  objectType: ObjectType,
  records: readonly T[],
): Partial<T>[] {
  return records.map((record) => stripHiddenFields(actor, objectType, record));
}

/**
 * Reject a write that touches a field the actor may not write (CLAUDE.md §5.4).
 *
 * Writes are **rejected**, not silently dropped. Dropping would tell the user
 * their edit was saved when it was not, and would hide a genuine permission
 * misconfiguration from whoever set it up.
 *
 * A hidden field is reported exactly like a read-only one, so the error cannot be
 * used to discover which fields exist but are concealed.
 */
export function assertWritableFields(
  actor: Actor,
  objectType: ObjectType,
  fieldKeys: readonly string[],
): void {
  const rejected = fieldKeys.filter((key) => !canWriteField(actor, objectType, key));
  if (rejected.length > 0) {
    throw new FieldNotWritableError(rejected);
  }
}

/** The subset of `fieldKeys` the actor may read. Used to build list columns. */
export function readableFieldKeys(
  actor: Actor,
  objectType: ObjectType,
  fieldKeys: readonly string[],
): string[] {
  return fieldKeys.filter((key) => canReadField(actor, objectType, key));
}

/** The subset of `fieldKeys` the actor may write. Used to build forms. */
export function writableFieldKeys(
  actor: Actor,
  objectType: ObjectType,
  fieldKeys: readonly string[],
): string[] {
  return fieldKeys.filter((key) => canWriteField(actor, objectType, key));
}
