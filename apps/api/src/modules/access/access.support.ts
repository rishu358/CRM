import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIONS,
  applyPermissionPatch,
  canonicalPermissionState,
  compilePermissions,
  diffAccess,
  GRANT_CATALOGUE,
  grantsBeyond,
  isGrantable,
  can,
  scopeRank,
  ValidationError,
  type Action,
  type Actor,
  type ErrorDetail,
  type ObjectType,
  type PermissionPatchCells,
  type PermissionState,
  type Scope,
} from '@crm/core';
import type { AccessCatalogue, EffectPreview, PermissionPatch } from '@crm/contracts';
import {
  countOwnedRecords,
  isOwnedObjectType,
  loadActors,
  type Tx,
} from '@crm/db';
import { AccessRepository } from './access.repository.js';

/**
 * The parts of M3 that more than one service needs: what can be granted, what a
 * patch is allowed to say, and what a change would **do**.
 *
 * ## Where the preview comes from
 *
 * The effect of a change is computed by running the people it touches through
 * `can()` twice — once as they are, once with the proposed permissions
 * compiled in — and diffing the answers (`diffAccess` in `@crm/core`). There is
 * no function in this file that decides what a role "means". Counting records
 * is the one thing the engine cannot do itself, and it is done under the
 * constraint `can()` handed back, translated by the same `constraintToSql`
 * every list endpoint puts in its WHERE clause.
 *
 * ## What it will not tell you
 *
 * Counts are information about records. They are returned only for an object the
 * viewer can read in full (`read` at `all` scope); a viewer with narrower
 * reach gets the change itself — who loses what scope — and no number. Without
 * that rule, anybody who may edit roles could size the whole workspace's data
 * by previewing a change, whatever their own reach (ADR-0033).
 */
@Injectable()
export class AccessSupport {
  constructor(@Inject(AccessRepository) private readonly repository: AccessRepository) {}

  // -------------------------------------------------------------------------
  // The catalogue
  // -------------------------------------------------------------------------

  async catalogue(tx: Tx, tenantId: string): Promise<AccessCatalogue> {
    const fields = await this.repository.activeFieldKeys(tx, tenantId);
    return {
      objects: GRANT_CATALOGUE.map((entry) => ({
        objectType: entry.objectType,
        kind: entry.kind,
        actions: [...entry.actions],
        scopes: [...entry.scopes],
        fields:
          entry.kind === 'record'
            ? [...(fields.get(entry.objectType) ?? new Map<string, string>()).entries()].map(
                ([key, label]) => ({ key, label }),
              )
            : [],
      })),
    };
  }

  digest(state: PermissionState): string {
    return createHash('sha256').update(canonicalPermissionState(state)).digest('hex').slice(0, 40);
  }

  // -------------------------------------------------------------------------
  // What a patch may say
  // -------------------------------------------------------------------------

  /**
   * Refuse a patch that names things that do not exist or are not grantable.
   *
   * Field rules are checked against the tenant's **active field metadata**, not
   * against a list in the code (CLAUDE.md §6): a custom field is ruleable the
   * moment it exists, and a key that does not exist is a 422 rather than a row
   * that would never apply to anything.
   */
  async validatePatch(tx: Tx, tenantId: string, patch: PermissionPatch): Promise<void> {
    const problems: ErrorDetail[] = [];

    patch.grants.forEach((grant, index) => {
      if (grant.scope !== null && !isGrantable(grant.objectType, grant.action, grant.scope)) {
        problems.push({
          path: `grants.${index}`,
          message: `${grant.action} on ${grant.objectType} cannot be granted at ${grant.scope} scope`,
        });
      }
    });

    if (patch.fieldRules.length > 0) {
      const fields = await this.repository.activeFieldKeys(tx, tenantId);
      patch.fieldRules.forEach((rule, index) => {
        const entry = GRANT_CATALOGUE.find((candidate) => candidate.objectType === rule.objectType);
        if (entry?.kind !== 'record' || !fields.get(rule.objectType)?.has(rule.fieldKey)) {
          problems.push({
            path: `fieldRules.${index}`,
            message: `${rule.objectType} has no field ${rule.fieldKey}`,
          });
        }
      });
    }

    if (problems.length > 0) throw new ValidationError(problems);
  }

  /** The grants a patch would **add or widen** that go beyond what the viewer holds. */
  beyondViewer(viewer: Actor, patch: PermissionPatchCells) {
    return grantsBeyond(
      viewer,
      patch.grants.flatMap((grant) =>
        grant.scope === null
          ? []
          : [{ objectType: grant.objectType, action: grant.action, scope: grant.scope }],
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Lock-out
  // -------------------------------------------------------------------------

  /** Somebody who can manage roles and members. Asked of the engine, never of a role name. */
  isAdministrator(actor: Actor): boolean {
    return (
      can(actor, 'update', { objectType: 'role' }).allowed &&
      can(actor, 'update', { objectType: 'membership' }).allowed
    );
  }

  /**
   * Whether anybody in the workspace could still manage roles and members.
   *
   * Reads every active member's real actor (`loadActors`), swaps in the
   * `overrides`, and asks `can()`. Called after a change has been written but
   * before it is committed, so a refusal rolls the whole thing back.
   */
  async administratorsRemain(
    tx: Tx,
    tenantId: string,
    overrides: ReadonlyMap<string, Actor | null> = new Map(),
  ): Promise<boolean> {
    const ids = await this.repository.activeMemberIds(tx, tenantId);
    const actors = await loadActors(tx, tenantId, ids);
    for (const [userId, actor] of actors) {
      const effective = overrides.has(userId) ? overrides.get(userId) : actor;
      if (effective !== null && effective !== undefined && this.isAdministrator(effective)) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // The effect of a change
  // -------------------------------------------------------------------------

  /** An actor as they would be if `state` were the permissions of their role. */
  withPermissions(actor: Actor, roleId: string, state: PermissionState): Actor {
    return {
      ...actor,
      permissions: compilePermissions(
        state.grants.map((cell) => ({ ...cell, roleId: roleId as never })),
        state.fieldRules.map((cell) => ({ ...cell, roleId: roleId as never })),
      ),
    };
  }

  /** `current` with `patch` applied — the one definition shared by preview and save. */
  proposed(current: PermissionState, patch: PermissionPatchCells): PermissionState {
    return applyPermissionPatch(current, patch);
  }

  async effect(
    tx: Tx,
    viewer: Actor,
    input: {
      readonly subject: EffectPreview['subject'];
      readonly digest: string;
      readonly people: readonly {
        readonly userId: string;
        readonly name: string;
        readonly email: string;
        readonly before: Actor;
        readonly after: Actor;
      }[];
      /** Everyone else's actor as they stand, with this change's people replaced. */
      readonly afterOverrides: ReadonlyMap<string, Actor | null>;
      readonly patch: PermissionPatchCells | null;
    },
  ): Promise<EffectPreview> {
    const tenantId = viewer.tenantId;
    const catalogue = await this.catalogue(tx, tenantId);
    const labels = new Map<string, string>();
    for (const object of catalogue.objects) {
      for (const field of object.fields) labels.set(`${object.objectType}:${field.key}`, field.label);
    }
    const objects = catalogue.objects.map((object) => ({
      objectType: object.objectType as ObjectType,
      fieldKeys: object.fields.map((field) => field.key),
    }));

    const counter = this.counter(tx, tenantId);
    const countable = (objectType: ObjectType): boolean => {
      if (!isOwnedObjectType(objectType)) return false;
      const reading = can(viewer, 'read', { objectType });
      return reading.allowed && reading.scope === 'all';
    };

    const people: EffectPreview['people'] = [];
    let unaffectedCount = 0;

    for (const person of input.people) {
      const diff = diffAccess(person.before, person.after, objects, ACTIONS);
      if (diff.scopeChanges.length === 0 && diff.fieldChanges.length === 0) {
        unaffectedCount += 1;
        continue;
      }

      const scopeChanges: EffectPreview['people'][number]['scopeChanges'] = [];
      for (const change of diff.scopeChanges) {
        let recordsBefore: number | null = null;
        let recordsAfter: number | null = null;
        if (countable(change.objectType)) {
          recordsBefore = await counter(person.before, change.action, change.objectType);
          recordsAfter = await counter(person.after, change.action, change.objectType);
        }
        scopeChanges.push({
          ...change,
          recordsBefore,
          recordsAfter,
          recordsLost:
            recordsBefore === null || recordsAfter === null
              ? null
              : Math.max(0, recordsBefore - recordsAfter),
          recordsGained:
            recordsBefore === null || recordsAfter === null
              ? null
              : Math.max(0, recordsAfter - recordsBefore),
        });
      }

      people.push({
        userId: person.userId,
        name: person.name,
        email: person.email,
        scopeChanges,
        fieldChanges: diff.fieldChanges.map((change) => ({
          ...change,
          fieldLabel: labels.get(`${change.objectType}:${change.fieldKey}`) ?? change.fieldKey,
        })),
      });
    }

    const summary = this.summarise(people);

    const removesLastAdministrator =
      (await this.administratorsRemain(tx, tenantId)) &&
      !(await this.administratorsRemain(tx, tenantId, input.afterOverrides));

    return {
      subject: input.subject,
      digest: input.digest,
      people,
      unaffectedCount,
      summary,
      removesLastAdministrator,
      beyondYourAccess:
        input.patch === null
          ? []
          : this.beyondViewer(viewer, input.patch).map((grant) => ({ ...grant })),
    };
  }

  private summarise(people: EffectPreview['people']): EffectPreview['summary'] {
    const groups = new Map<string, EffectPreview['summary'][number]>();
    for (const person of people) {
      for (const change of person.scopeChanges) {
        const key = `${change.objectType}|${change.action}|${change.direction}`;
        const existing = groups.get(key);
        const lost = change.recordsLost;
        const gained = change.recordsGained;
        if (existing === undefined) {
          groups.set(key, {
            objectType: change.objectType,
            action: change.action,
            direction: change.direction,
            peopleAffected: 1,
            recordsLostMax: lost,
            recordViewsLost: lost,
            recordsGainedMax: gained,
            recordViewsGained: gained,
          });
        } else {
          groups.set(key, {
            ...existing,
            peopleAffected: existing.peopleAffected + 1,
            recordsLostMax: maxOrNull(existing.recordsLostMax, lost),
            recordViewsLost: sumOrNull(existing.recordViewsLost, lost),
            recordsGainedMax: maxOrNull(existing.recordsGainedMax, gained),
            recordViewsGained: sumOrNull(existing.recordViewsGained, gained),
          });
        }
      }
    }
    return [...groups.values()];
  }

  /**
   * How many records an actor's `action` reaches on an object, memoised.
   *
   * Keyed by the constraint rather than the person: ten reps sharing an
   * `all` scope cost one count, not ten.
   */
  private counter(tx: Tx, tenantId: string) {
    const cache = new Map<string, Promise<number>>();
    return (actor: Actor, action: Action, objectType: ObjectType): Promise<number> => {
      if (!isOwnedObjectType(objectType)) return Promise.resolve(0);
      const decision = can(actor, action, { objectType });
      if (!decision.allowed) return Promise.resolve(0);

      const key = `${objectType}|${JSON.stringify(decision.constraint)}`;
      let pending = cache.get(key);
      if (pending === undefined) {
        pending = countOwnedRecords(tx, tenantId, objectType, decision.constraint);
        cache.set(key, pending);
      }
      return pending;
    };
  }

  /** The counter, for services that count a single subject's reach. */
  countFor(tx: Tx, tenantId: string) {
    return this.counter(tx, tenantId);
  }

  /** Whether the viewer may be told how many records of this kind exist. */
  mayCount(viewer: Actor, objectType: ObjectType): boolean {
    if (!isOwnedObjectType(objectType)) return false;
    const reading = can(viewer, 'read', { objectType });
    return reading.allowed && reading.scope === 'all';
  }

  /** Scope comparison, for callers that need "is this narrower". */
  narrower(a: Scope | null, b: Scope | null): boolean {
    if (a === null) return b !== null;
    if (b === null) return false;
    return scopeRank(b) < scopeRank(a);
  }
}

function maxOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.max(a, b);
}

function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}
