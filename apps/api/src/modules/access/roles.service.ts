import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  ConflictError,
  diffPermissionState,
  grantsBeyond,
  LastAdministratorError,
  NotFoundError,
  PermissionEscalationError,
  RoleInUseError,
  VersionConflictError,
  type Actor,
  type PermissionState,
} from '@crm/core';
import type {
  PermissionApplyInput,
  PermissionPatch,
  RoleCreateInput,
  RoleDetail,
  RoleSummary,
  RoleUpdateInput,
  EffectPreview,
} from '@crm/contracts';
import { loadActors, type Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccessRepository, type RoleRow } from './access.repository.js';
import { AccessSupport } from './access.support.js';

/**
 * Roles and their permissions (MVP_SPEC M3).
 *
 * Every method here authorizes through `can()` against the `role` object, like
 * every other endpoint. There is no "is admin" shortcut and no role name is
 * ever compared: an Owner is a role whose rows grant these things, so a custom
 * "People manager" role granted `role:update` administers roles exactly as an
 * Admin does (CLAUDE.md §5.3).
 *
 * ## Four rules that hold on every write
 *
 *  1. **What was previewed is what is saved.** A save carries the digest of the
 *     permissions the preview was computed against; it is refused if the role
 *     has changed since, because the consequences shown were of a state that no
 *     longer exists. The role row is locked across the check and the write, so
 *     two administrators saving at once cannot both pass it.
 *  2. **You cannot hand out what you do not hold.** Anything a patch adds or
 *     widens is checked against the actor's own reach through `can()`.
 *     Otherwise `role:update` would be a path to every other permission.
 *  3. **The workspace keeps an administrator.** After the write, before the
 *     commit, the engine is asked whether anybody can still manage roles and
 *     members; if not, the whole change rolls back.
 *  4. **It is audited in the same transaction** as a `permission_change`,
 *     carrying exactly the cells that moved (CLAUDE.md §5.10).
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessRepository) private readonly repository: AccessRepository,
    @Inject(AccessSupport) private readonly support: AccessSupport,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(actor: Actor): Promise<RoleSummary[]> {
    assertCan(actor, 'read', { objectType: 'role' });
    return this.inTenant(actor, async (tx) => {
      const roles = await this.repository.listRoles(tx, actor.tenantId);
      return roles.map(toSummary);
    });
  }

  async get(actor: Actor, id: string): Promise<RoleDetail> {
    assertCan(actor, 'read', { objectType: 'role' });
    return this.inTenant(actor, (tx) => this.detail(tx, actor, id));
  }

  async create(actor: Actor, input: RoleCreateInput): Promise<RoleDetail> {
    assertCan(actor, 'create', { objectType: 'role' });

    return this.inTenant(actor, async (tx) => {
      let copied: PermissionState = { grants: [], fieldRules: [] };

      if (input.copyFromRoleId !== undefined && input.copyFromRoleId !== null) {
        const source = await this.repository.findRole(tx, actor.tenantId, input.copyFromRoleId);
        if (source === null) throw new NotFoundError('Role');
        copied = await this.repository.loadPermissionState(tx, actor.tenantId, source.id);

        // A copy is a grant like any other: it may not reach further than you do.
        const beyond = grantsBeyond(actor, copied.grants);
        if (beyond.length > 0) {
          throw new PermissionEscalationError(
            beyond.map((grant) => `${grant.objectType}.${grant.action}`),
          );
        }
      }

      let id: string;
      try {
        id = await this.repository.insertRole(tx, {
          tenantId: actor.tenantId,
          name: input.name,
          description: input.description ?? null,
          createdBy: actor.userId,
        });
      } catch (error) {
        if (isConstraintViolation(error, 'roles_tenant_name_key')) {
          throw new ConflictError('A role with that name already exists');
        }
        throw error;
      }

      for (const cell of copied.grants) {
        await this.repository.upsertGrant(tx, actor.tenantId, id, cell, actor.userId);
      }
      for (const cell of copied.fieldRules) {
        await this.repository.upsertFieldRule(tx, actor.tenantId, id, cell, actor.userId);
      }

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'role',
        recordId: id,
        changes: {
          name: { new: input.name },
          ...(input.copyFromRoleId ? { copiedFrom: { new: input.copyFromRoleId } } : {}),
        },
      });
      const cells = diffPermissionState({ grants: [], fieldRules: [] }, copied);
      if (Object.keys(cells).length > 0) {
        await this.audit.record(tx, actor, {
          action: 'permission_change',
          objectType: 'role',
          recordId: id,
          changes: cells,
        });
      }
      await this.outbox.publish(tx, actor, {
        eventType: 'role.created.v1',
        objectType: 'role',
        recordId: id,
      });

      return this.detail(tx, actor, id);
    });
  }

  async update(actor: Actor, id: string, input: RoleUpdateInput): Promise<RoleDetail> {
    assertCan(actor, 'update', { objectType: 'role' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.findRole(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Role');

      if (existing.isSystem && input.name !== undefined && input.name !== existing.name) {
        // System roles are what documentation, invitations and support refer to
        // by name; renaming one would make "Sales Rep" mean something else.
        throw new ConflictError('System roles keep their names');
      }

      try {
        await this.repository.updateRole(
          tx,
          actor.tenantId,
          id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
          },
          actor.userId,
        );
      } catch (error) {
        if (isConstraintViolation(error, 'roles_tenant_name_key')) {
          throw new ConflictError('A role with that name already exists');
        }
        throw error;
      }

      const updated = await this.repository.findRole(tx, actor.tenantId, id);
      const changes = diffChanges(
        { name: existing.name, description: existing.description },
        { name: updated?.name ?? existing.name, description: updated?.description ?? null },
      );
      if (Object.keys(changes).length > 0) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'role',
          recordId: id,
          changes,
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'role.updated.v1',
          objectType: 'role',
          recordId: id,
          payload: { changedFields: Object.keys(changes) },
        });
      }

      return this.detail(tx, actor, id);
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'role' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.repository.findRole(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Role');
      if (existing.isSystem) throw new ConflictError('System roles cannot be deleted');
      if (existing.memberCount > 0) throw new RoleInUseError(existing.memberCount);

      try {
        await this.repository.deleteRole(tx, actor.tenantId, id);
      } catch (error) {
        // An invitation, even a settled one, keeps a reference to the role it
        // conferred, so the database refuses (ADR-0019).
        if (isConstraintViolation(error, 'invitations_role_id_fkey')) {
          throw new ConflictError(
            'This role was used in an invitation and cannot be deleted. Rename it instead.',
          );
        }
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'role',
        recordId: id,
        changes: { name: { old: existing.name } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'role.deleted.v1',
        objectType: 'role',
        recordId: id,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  /**
   * What the change would do, before anybody commits to it.
   *
   * For each active member holding the role, their real Actor is loaded
   * (`loadActors`, the code every request uses), and a second Actor is built
   * from it with the role's permissions replaced by the patched ones. The
   * difference between the two, as `can()` sees it, is the preview. Nothing is
   * written.
   */
  async preview(actor: Actor, id: string, patch: PermissionPatch): Promise<EffectPreview> {
    assertCan(actor, 'update', { objectType: 'role' });

    return this.inTenant(actor, async (tx) => {
      const role = await this.repository.findRole(tx, actor.tenantId, id);
      if (role === null) throw new NotFoundError('Role');

      await this.support.validatePatch(tx, actor.tenantId, patch);

      const current = await this.repository.loadPermissionState(tx, actor.tenantId, id);
      const proposed = this.support.proposed(current, patch);

      const members = await this.repository.activeMembersOfRole(tx, actor.tenantId, id);
      const before = await loadActors(
        tx,
        actor.tenantId,
        members.map((member) => member.userId),
      );

      const people: Parameters<AccessSupport['effect']>[2]['people'][number][] = [];
      const afterOverrides = new Map<string, Actor | null>();
      for (const member of members) {
        const actorBefore = before.get(member.userId);
        if (actorBefore === undefined) continue;
        const actorAfter = this.support.withPermissions(actorBefore, id, proposed);
        afterOverrides.set(member.userId, actorAfter);
        people.push({ ...member, before: actorBefore, after: actorAfter });
      }

      return this.support.effect(tx, actor, {
        subject: { kind: 'role', id, name: role.name },
        digest: this.support.digest(current),
        people,
        afterOverrides,
        patch,
      });
    });
  }

  async apply(actor: Actor, id: string, input: PermissionApplyInput): Promise<RoleDetail> {
    assertCan(actor, 'update', { objectType: 'role' });

    return this.inTenant(actor, async (tx) => {
      await this.repository.lockAdministration(tx, actor.tenantId);
      if (!(await this.repository.lockRole(tx, actor.tenantId, id))) {
        throw new NotFoundError('Role');
      }

      const current = await this.repository.loadPermissionState(tx, actor.tenantId, id);
      if (this.support.digest(current) !== input.expectedDigest) {
        // Somebody saved since this administrator previewed. What they were
        // shown the consequences of is no longer what is there.
        throw new VersionConflictError('role');
      }

      await this.support.validatePatch(tx, actor.tenantId, input);

      const beyond = this.support.beyondViewer(actor, input);
      if (beyond.length > 0) {
        throw new PermissionEscalationError(
          beyond.map((grant) => `${grant.objectType}.${grant.action}`),
        );
      }

      const proposed = this.support.proposed(current, input);
      const changes = diffPermissionState(current, proposed);
      if (Object.keys(changes).length === 0) return this.detail(tx, actor, id);

      for (const grant of input.grants) {
        if (grant.scope === null) {
          await this.repository.deleteGrant(tx, actor.tenantId, id, grant.objectType, grant.action);
        } else {
          await this.repository.upsertGrant(
            tx,
            actor.tenantId,
            id,
            { objectType: grant.objectType, action: grant.action, scope: grant.scope },
            actor.userId,
          );
        }
      }
      for (const rule of input.fieldRules) {
        if (rule.access === null) {
          await this.repository.deleteFieldRule(
            tx,
            actor.tenantId,
            id,
            rule.objectType,
            rule.fieldKey,
          );
        } else {
          await this.repository.upsertFieldRule(
            tx,
            actor.tenantId,
            id,
            { objectType: rule.objectType, fieldKey: rule.fieldKey, access: rule.access },
            actor.userId,
          );
        }
      }

      // The lock-out check reads the permissions just written, so it has to
      // come after them and before the commit.
      if (!(await this.support.administratorsRemain(tx, actor.tenantId))) {
        throw new LastAdministratorError();
      }

      await this.audit.record(tx, actor, {
        action: 'permission_change',
        objectType: 'role',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'role.permissions_changed.v1',
        objectType: 'role',
        recordId: id,
        payload: { changedCells: Object.keys(changes).length },
      });

      return this.detail(tx, actor, id);
    });
  }

  // -------------------------------------------------------------------------

  private async detail(tx: Tx, actor: Actor, id: string): Promise<RoleDetail> {
    const role = await this.repository.findRole(tx, actor.tenantId, id);
    if (role === null) throw new NotFoundError('Role');
    const state = await this.repository.loadPermissionState(tx, actor.tenantId, id);

    return {
      ...toSummary(role),
      grants: [...state.grants].sort(
        (a, b) => a.objectType.localeCompare(b.objectType) || a.action.localeCompare(b.action),
      ),
      fieldRules: [...state.fieldRules].sort(
        (a, b) => a.objectType.localeCompare(b.objectType) || a.fieldKey.localeCompare(b.fieldKey),
      ),
      digest: this.support.digest(state),
    };
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function toSummary(role: RoleRow): RoleSummary {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    memberCount: role.memberCount,
    grantCount: role.grantCount,
  };
}
