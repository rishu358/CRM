import type { Action, ObjectType, Scope } from '../objects/index.js';
import type { FieldAccess } from './types.js';

/**
 * A role's permissions as plain cells, and what a patch does to them.
 *
 * The **preview** and the **save** both go through `applyPermissionPatch`, so
 * the permissions an administrator is shown the consequences of are, by
 * construction, the ones that are written. Two implementations of "what the role
 * looks like after this change" would be a place for the preview to be right
 * and the save to be different.
 */

export interface GrantCell {
  readonly objectType: ObjectType;
  readonly action: Action;
  readonly scope: Scope;
}

export interface FieldRuleCell {
  readonly objectType: ObjectType;
  readonly fieldKey: string;
  readonly access: FieldAccess;
}

export interface PermissionState {
  readonly grants: readonly GrantCell[];
  readonly fieldRules: readonly FieldRuleCell[];
}

export interface PermissionPatchCells {
  /** `scope: null` removes the grant. */
  readonly grants: readonly {
    readonly objectType: ObjectType;
    readonly action: Action;
    readonly scope: Scope | null;
  }[];
  /** `access: null` removes the rule, so the field inherits from the object grant. */
  readonly fieldRules: readonly {
    readonly objectType: ObjectType;
    readonly fieldKey: string;
    readonly access: FieldAccess | null;
  }[];
}

const grantId = (cell: { objectType: string; action: string }): string =>
  `${cell.objectType}.${cell.action}`;
const ruleId = (cell: { objectType: string; fieldKey: string }): string =>
  `${cell.objectType}.${cell.fieldKey}`;

/**
 * Apply a patch to a role's current cells.
 *
 * Later entries for the same cell win, so a client that sends the same cell
 * twice gets the last thing it said rather than an arbitrary one.
 */
export function applyPermissionPatch(
  current: PermissionState,
  patch: PermissionPatchCells,
): PermissionState {
  const grants = new Map<string, GrantCell>(current.grants.map((cell) => [grantId(cell), cell]));
  for (const change of patch.grants) {
    if (change.scope === null) grants.delete(grantId(change));
    else grants.set(grantId(change), { ...change, scope: change.scope });
  }

  const rules = new Map<string, FieldRuleCell>(
    current.fieldRules.map((cell) => [ruleId(cell), cell]),
  );
  for (const change of patch.fieldRules) {
    if (change.access === null) rules.delete(ruleId(change));
    else rules.set(ruleId(change), { ...change, access: change.access });
  }

  return { grants: [...grants.values()], fieldRules: [...rules.values()] };
}

/** The cells that differ, keyed for an audit entry's `{ old, new }` diff. */
export function diffPermissionState(
  before: PermissionState,
  after: PermissionState,
): Record<string, { old?: unknown; new?: unknown }> {
  const changes: Record<string, { old?: unknown; new?: unknown }> = {};

  const beforeGrants = new Map(before.grants.map((cell) => [grantId(cell), cell.scope]));
  const afterGrants = new Map(after.grants.map((cell) => [grantId(cell), cell.scope]));
  for (const key of new Set([...beforeGrants.keys(), ...afterGrants.keys()])) {
    const was = beforeGrants.get(key);
    const now = afterGrants.get(key);
    if (was === now) continue;
    changes[`grant:${key}`] = {
      ...(was === undefined ? {} : { old: was }),
      ...(now === undefined ? {} : { new: now }),
    };
  }

  const beforeRules = new Map(before.fieldRules.map((cell) => [ruleId(cell), cell.access]));
  const afterRules = new Map(after.fieldRules.map((cell) => [ruleId(cell), cell.access]));
  for (const key of new Set([...beforeRules.keys(), ...afterRules.keys()])) {
    const was = beforeRules.get(key);
    const now = afterRules.get(key);
    if (was === now) continue;
    changes[`field:${key}`] = {
      ...(was === undefined ? {} : { old: was }),
      ...(now === undefined ? {} : { new: now }),
    };
  }

  return changes;
}

/**
 * A stable fingerprint input: the cells in a fixed order.
 *
 * The digest itself is hashed where `node:crypto` lives; this only guarantees
 * that two equal states serialise identically whatever order they were read in.
 */
export function canonicalPermissionState(state: PermissionState): string {
  const grants = state.grants.map((c) => `g|${c.objectType}|${c.action}|${c.scope}`);
  const rules = state.fieldRules.map((c) => `f|${c.objectType}|${c.fieldKey}|${c.access}`);
  return [...grants, ...rules].sort().join('\n');
}
