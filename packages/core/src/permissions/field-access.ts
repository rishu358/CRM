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
 * What a single role can do with a field, before union across roles.
 *
 * The base comes from the role's object-level grant: a role that cannot read the
 * object cannot read any of its fields, and a role that can only read it cannot
 * write any of them. A `field_permissions` row then **narrows** that base.
 *
 * Field permissions can only restrict, never widen. Otherwise a stray field row
 * would hand out write access to an object the role was never granted, and
 * field-level configuration would become a way around object-level permissions.
 */
function accessForRole(role: CompiledRole, objectType: ObjectType, fieldKey: string): FieldAccess {
  const canWrite = role.grants.has(grantKey(objectType, 'update'));
  const canRead = role.grants.has(grantKey(objectType, 'read'));

  const base: FieldAccess = canWrite ? 'write' : canRead ? 'read' : 'hidden';
  if (base === 'hidden') return 'hidden';

  const override = role.fieldOverrides.get(fieldKeyOf(objectType, fieldKey));
  return override === undefined ? base : narrower(override, base);
}

/**
 * The actor's effective access to one field.
 *
 * Union across the actor's roles, matching how object grants combine in `can()`:
 * holding an extra role never takes access away.
 */
export function fieldAccess(actor: Actor, objectType: ObjectType, fieldKey: string): FieldAccess {
  let effective: FieldAccess = 'hidden';
  for (const role of actor.permissions.roles) {
    effective = wider(effective, accessForRole(role, objectType, fieldKey));
    if (effective === 'write') break;
  }
  return effective;
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
