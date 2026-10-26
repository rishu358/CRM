import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  LastAdministratorError,
  NotFoundError,
  PermissionEscalationError,
  ValidationError,
  type Actor,
} from '@crm/core';
import type { EffectPreview, Member, MemberListQuery, MemberUpdateInput } from '@crm/contracts';
import { loadActors, type Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccessRepository, type MemberRow } from './access.repository.js';
import { AccessSupport } from './access.support.js';

/**
 * The people in a workspace, their roles and their status (MVP_SPEC M3).
 *
 * Moving somebody to another role is a permission change, so it is previewed,
 * audited as one, and bound by the same two rules roles are: you cannot hand a
 * person a role wider than your own, and the workspace keeps an administrator.
 *
 * Suspending takes effect on the person's **next request**: every request
 * rebuilds the actor from `memberships` (`loadActor` returns nothing for a
 * suspended one), so there is no cached permission to wait out.
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessRepository) private readonly repository: AccessRepository,
    @Inject(AccessSupport) private readonly support: AccessSupport,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(
    actor: Actor,
    query: MemberListQuery,
  ): Promise<{ data: Member[]; meta: { hasMore: boolean } }> {
    assertCan(actor, 'read', { objectType: 'membership' });

    return this.inTenant(actor, async (tx) => {
      // One row more than asked for, so "is there another page" needs no count.
      const rows = await this.repository.listMembers(
        tx,
        actor.tenantId,
        query.status,
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      return { data: await this.present(tx, actor, page), meta: { hasMore } };
    });
  }

  async update(actor: Actor, userId: string, input: MemberUpdateInput): Promise<Member> {
    assertCan(actor, 'update', { objectType: 'membership' });

    return this.inTenant(actor, async (tx) => {
      await this.repository.lockAdministration(tx, actor.tenantId);
      const existing = await this.repository.findMember(tx, actor.tenantId, userId);
      if (existing === null) throw new NotFoundError('Member');

      if (input.status === 'suspended' && userId === actor.userId) {
        throw new ValidationError([
          { path: 'status', message: 'You cannot suspend your own access' },
        ]);
      }

      let newRoleName: string | null = null;
      if (input.roleId !== undefined && input.roleId !== existing.roleId) {
        const role = await this.repository.findRole(tx, actor.tenantId, input.roleId);
        if (role === null) throw new ValidationError([{ path: 'roleId', message: 'Unknown role' }]);

        const cells = await this.repository.loadPermissionState(tx, actor.tenantId, role.id);
        const beyond = this.support.beyondViewer(actor, {
          grants: cells.grants.map((cell) => ({ ...cell })),
          fieldRules: [],
        });
        if (beyond.length > 0) {
          throw new PermissionEscalationError(
            beyond.map((grant) => `${grant.objectType}.${grant.action}`),
          );
        }
        newRoleName = role.name;
      }

      const roleChanged = newRoleName !== null;
      const statusChanged = input.status !== undefined && input.status !== existing.status;
      if (!roleChanged && !statusChanged) {
        return (await this.present(tx, actor, [existing]))[0] as Member;
      }

      await this.repository.updateMembership(
        tx,
        actor.tenantId,
        userId,
        {
          ...(roleChanged && input.roleId !== undefined ? { roleId: input.roleId } : {}),
          ...(statusChanged && input.status !== undefined ? { status: input.status } : {}),
        },
        actor.userId,
      );

      // After the write, before the commit: a refusal rolls it all back. This
      // is what stops an administrator demoting or suspending the last one,
      // themselves included.
      if (!(await this.support.administratorsRemain(tx, actor.tenantId))) {
        throw new LastAdministratorError();
      }

      await this.audit.record(tx, actor, {
        action: 'permission_change',
        objectType: 'membership',
        recordId: userId,
        changes: {
          ...(roleChanged ? { role: { old: existing.roleName, new: newRoleName } } : {}),
          ...(statusChanged ? { status: { old: existing.status, new: input.status } } : {}),
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'membership.updated.v1',
        objectType: 'membership',
        recordId: userId,
        payload: { roleChanged, statusChanged },
      });

      const updated = await this.repository.findMember(tx, actor.tenantId, userId);
      return (await this.present(tx, actor, [updated ?? existing]))[0] as Member;
    });
  }

  /** What moving this person to another role would do — nothing is written. */
  async previewRole(actor: Actor, userId: string, roleId: string): Promise<EffectPreview> {
    assertCan(actor, 'update', { objectType: 'membership' });
    assertCan(actor, 'read', { objectType: 'role' });

    return this.inTenant(actor, async (tx) => {
      const member = await this.repository.findMember(tx, actor.tenantId, userId);
      if (member === null || member.status !== 'active') throw new NotFoundError('Member');

      const role = await this.repository.findRole(tx, actor.tenantId, roleId);
      if (role === null) throw new NotFoundError('Role');

      const before = (await loadActors(tx, actor.tenantId, [userId])).get(userId);
      if (before === undefined) throw new NotFoundError('Member');

      const target = await this.repository.loadPermissionState(tx, actor.tenantId, roleId);
      const after = this.support.withPermissions(before, roleId, target);

      return this.support.effect(tx, actor, {
        subject: { kind: 'member', id: userId, name: member.name },
        digest: this.support.digest(target),
        people: [{ userId, name: member.name, email: member.email, before, after }],
        afterOverrides: new Map([[userId, after]]),
        patch: { grants: target.grants.map((cell) => ({ ...cell })), fieldRules: [] },
      });
    });
  }

  // -------------------------------------------------------------------------

  private async present(tx: Tx, actor: Actor, rows: readonly MemberRow[]): Promise<Member[]> {
    const teams = await this.repository.listTeams(tx, actor.tenantId);
    const names = new Map(teams.map((team) => [team.id, team.name]));
    const links = await this.repository.teamMembers(tx, actor.tenantId);

    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      roleId: row.roleId,
      roleName: row.roleName,
      status: row.status,
      teams: links
        .filter((link) => link.userId === row.userId)
        .map((link) => ({ id: link.teamId, name: names.get(link.teamId) ?? '' })),
      joinedAt: row.joinedAt?.toISOString() ?? null,
      isYou: row.userId === actor.userId,
    }));
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
