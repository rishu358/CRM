import { Inject, Injectable } from '@nestjs/common';
import { assertCan, ConflictError, NotFoundError, ValidationError, type Actor } from '@crm/core';
import type { Team, TeamCreateInput, TeamMembersInput, TeamUpdateInput } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { AccessRepository, type TeamMemberRow, type TeamRow } from './access.repository.js';

/**
 * Teams (MVP_SPEC M3).
 *
 * A team is what `team` scope resolves through: a person under `team` scope
 * reaches the records owned by anyone who shares a team with them
 * (`constraintToSql`). So who is **on** a team is a permission, and changing it
 * is audited as a `permission_change` rather than as an ordinary update.
 *
 * The hierarchy (`parent_team_id`) is stored and kept acyclic but does not yet
 * widen anyone's reach: scope resolves through direct membership only.
 * Territories are P2 (MVP_SPEC §6.1), and turning on inheritance silently would
 * change what people can see without anyone having asked for it.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessRepository) private readonly repository: AccessRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(actor: Actor): Promise<Team[]> {
    assertCan(actor, 'read', { objectType: 'team' });
    return this.inTenant(actor, async (tx) => {
      const teams = await this.repository.listTeams(tx, actor.tenantId);
      const links = await this.repository.teamMembers(tx, actor.tenantId);
      return teams.map((team) => present(team, links));
    });
  }

  async create(actor: Actor, input: TeamCreateInput): Promise<Team> {
    assertCan(actor, 'create', { objectType: 'team' });

    return this.inTenant(actor, async (tx) => {
      if (input.parentTeamId !== undefined && input.parentTeamId !== null) {
        await this.requireTeam(tx, actor, input.parentTeamId, 'parentTeamId');
      }

      let id: string;
      try {
        id = await this.repository.insertTeam(tx, {
          tenantId: actor.tenantId,
          name: input.name,
          parentTeamId: input.parentTeamId ?? null,
          createdBy: actor.userId,
        });
      } catch (error) {
        if (isConstraintViolation(error, 'teams_tenant_name_key')) {
          throw new ConflictError('A team with that name already exists');
        }
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'team',
        recordId: id,
        changes: { name: { new: input.name } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'team.created.v1',
        objectType: 'team',
        recordId: id,
      });
      return this.one(tx, actor, id);
    });
  }

  async update(actor: Actor, id: string, input: TeamUpdateInput): Promise<Team> {
    assertCan(actor, 'update', { objectType: 'team' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.findTeam(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Team');

      if (input.parentTeamId !== undefined && input.parentTeamId !== null) {
        await this.requireTeam(tx, actor, input.parentTeamId, 'parentTeamId');
        // Walking up from the proposed parent must never reach this team.
        const ancestors = await this.repository.ancestorIds(tx, actor.tenantId, input.parentTeamId);
        if (ancestors.includes(id)) {
          throw new ValidationError([
            { path: 'parentTeamId', message: 'A team cannot be placed beneath itself' },
          ]);
        }
      }

      try {
        await this.repository.updateTeam(
          tx,
          actor.tenantId,
          id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.parentTeamId === undefined ? {} : { parentTeamId: input.parentTeamId }),
          },
          actor.userId,
        );
      } catch (error) {
        if (isConstraintViolation(error, 'teams_tenant_name_key')) {
          throw new ConflictError('A team with that name already exists');
        }
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'team',
        recordId: id,
        changes: {
          ...(input.name !== undefined && input.name !== existing.name
            ? { name: { old: existing.name, new: input.name } }
            : {}),
          ...(input.parentTeamId !== undefined && input.parentTeamId !== existing.parentTeamId
            ? { parentTeamId: { old: existing.parentTeamId, new: input.parentTeamId } }
            : {}),
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'team.updated.v1',
        objectType: 'team',
        recordId: id,
      });
      return this.one(tx, actor, id);
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'team' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.repository.findTeam(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Team');

      const members = await this.repository.teamMembers(tx, actor.tenantId, [id]);
      await this.repository.deleteTeam(tx, actor.tenantId, id);

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'team',
        recordId: id,
        changes: { name: { old: existing.name } },
      });
      // People who reached records through this team under `team` scope stop
      // reaching them: that is a permission change whatever the screen called it.
      if (members.length > 0) {
        await this.audit.record(tx, actor, {
          action: 'permission_change',
          objectType: 'team',
          recordId: id,
          changes: { members: { old: members.map((member) => member.userId) } },
        });
      }
      await this.outbox.publish(tx, actor, {
        eventType: 'team.deleted.v1',
        objectType: 'team',
        recordId: id,
      });
    });
  }

  async setMembers(actor: Actor, id: string, input: TeamMembersInput): Promise<Team> {
    assertCan(actor, 'update', { objectType: 'team' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.findTeam(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Team');

      const wanted = [...new Set(input.userIds)];
      const known = await this.repository.existingMemberIds(tx, actor.tenantId, wanted);
      const unknown = wanted.filter((userId) => !known.has(userId));
      if (unknown.length > 0) {
        // Same answer for "no such user" and "a user in another workspace".
        throw new ValidationError(
          unknown.map((_, index) => ({ path: `userIds.${index}`, message: 'Unknown member' })),
        );
      }

      const before = (await this.repository.teamMembers(tx, actor.tenantId, [id])).map(
        (member) => member.userId,
      );
      const added = wanted.filter((userId) => !before.includes(userId));
      const removed = before.filter((userId) => !wanted.includes(userId));

      if (added.length > 0 || removed.length > 0) {
        await this.repository.replaceTeamMembers(tx, actor.tenantId, id, wanted, actor.userId);
        await this.audit.record(tx, actor, {
          action: 'permission_change',
          objectType: 'team',
          recordId: id,
          changes: {
            ...(added.length > 0 ? { membersAdded: { new: added } } : {}),
            ...(removed.length > 0 ? { membersRemoved: { old: removed } } : {}),
          },
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'team.members_changed.v1',
          objectType: 'team',
          recordId: id,
          payload: { added: added.length, removed: removed.length },
        });
      }
      return this.one(tx, actor, id);
    });
  }

  // -------------------------------------------------------------------------

  private async requireTeam(tx: Tx, actor: Actor, id: string, path: string): Promise<void> {
    if ((await this.repository.findTeam(tx, actor.tenantId, id)) === null) {
      throw new ValidationError([{ path, message: 'Unknown team' }]);
    }
  }

  private async one(tx: Tx, actor: Actor, id: string): Promise<Team> {
    const team = await this.repository.findTeam(tx, actor.tenantId, id);
    if (team === null) throw new NotFoundError('Team');
    const links = await this.repository.teamMembers(tx, actor.tenantId, [id]);
    return present(team, links);
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function present(team: TeamRow, links: readonly TeamMemberRow[]): Team {
  return {
    id: team.id,
    name: team.name,
    parentTeamId: team.parentTeamId,
    members: links
      .filter((link) => link.teamId === team.id)
      .map((link) => ({ userId: link.userId, name: link.name, email: link.email })),
  };
}
