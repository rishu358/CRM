import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  canReadField,
  compilePermissions,
  explainFieldVisibility,
  explainReach,
  explainRecordAccess,
  NotFoundError,
  type Actor,
  type ObjectType,
} from '@crm/core';
import type { AccessCatalogue, Reach, RecordAccess } from '@crm/contracts';
import {
  findOwnedRecord,
  loadActors,
  recordRefFor,
  teamIdsByUser,
  type OwnedObjectType,
  type Tx,
} from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AccessRepository } from './access.repository.js';
import { AccessSupport } from './access.support.js';

/** More people than this and the answer says it was cut short. */
const MAX_PEOPLE = 500;

/**
 * The access explainer (ADR-0033).
 *
 * **Nothing in this class decides what anybody may do.** Each answer is the
 * output of `can()` or the field engine for a real `Actor` — built by
 * `loadActors`, the function every request builds its actor with — translated
 * by `explainRecordAccess`, `explainFieldVisibility` and `explainReach` in
 * `@crm/core`. That is the property the whole feature stands on: an explainer
 * that computed its own answer would eventually disagree with the API, and one
 * that says somebody cannot see a record they can is worse than none.
 * `explainer.parity.security.spec.ts` holds it to that against what the HTTP
 * endpoints actually return.
 *
 * ## It is a read path across people, so it is fenced
 *
 *  - **Administrators only.** `role:read` and `membership:read`, by `can()`,
 *    before anything is loaded. A sales rep gets 403 and learns nothing: not
 *    who their colleagues are, not what role they hold, not which fields are
 *    hidden from them.
 *  - **Your own tenant, by construction.** People come from `memberships`
 *    under row-level security; an id from another workspace is simply absent.
 *  - **Only records you can read yourself.** The record is judged for the
 *    *viewer* first, and one outside their reach is a 404 — otherwise the
 *    explainer would confirm that a record exists, and who owns it, to somebody
 *    who cannot open it (CLAUDE.md §5.5). The collection-level grant is checked
 *    before the lookup so a 403 cannot be told apart from a 404 by probing ids.
 *  - **Only fields you can read yourself.** A field hidden from the viewer is
 *    not listed, not even to say who else can see it.
 *  - **Counts only where you could count anyway.** See `AccessSupport.mayCount`.
 */
@Injectable()
export class ExplainerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessRepository) private readonly repository: AccessRepository,
    @Inject(AccessSupport) private readonly support: AccessSupport,
  ) {}

  /** What can be granted, for the role editor. */
  async catalogue(actor: Actor): Promise<AccessCatalogue> {
    assertCan(actor, 'read', { objectType: 'role' });
    return this.inTenant(actor, (tx) => this.support.catalogue(tx, actor.tenantId));
  }

  /** Who can see this record, and why. */
  async recordAccess(actor: Actor, objectType: OwnedObjectType, id: string): Promise<RecordAccess> {
    this.assertAdministrator(actor);
    // The collection-level grant first, so 403 never depends on whether `id` exists.
    assertCan(actor, 'read', { objectType });

    return this.inTenant(actor, async (tx) => {
      const record = await findOwnedRecord(tx, actor.tenantId, objectType, id);
      if (record === null) throw new NotFoundError(objectType);

      // The viewer's own reach: out of scope is a 404, exactly as opening it would be.
      assertCan(actor, 'read', {
        objectType,
        record: await recordRefFor(tx, actor, record.ownerId),
      });

      const catalogue = await this.support.catalogue(tx, actor.tenantId);
      const object = catalogue.objects.find((candidate) => candidate.objectType === objectType);
      const fields = (object?.fields ?? []).filter((field) =>
        canReadField(actor, objectType, field.key),
      );

      const members = await this.repository.listMembers(
        tx,
        actor.tenantId,
        'active',
        MAX_PEOPLE + 1,
      );
      const truncated = members.length > MAX_PEOPLE;
      const people = truncated ? members.slice(0, MAX_PEOPLE) : members;

      const actors = await loadActors(
        tx,
        actor.tenantId,
        people.map((member) => member.userId),
      );

      // A record has no team column: its teams are its owner's.
      const ownerTeams =
        record.ownerId === null
          ? []
          : ((await teamIdsByUser(tx, actor.tenantId, [record.ownerId])).get(record.ownerId) ?? []);
      const ref = { ownerId: record.ownerId, ownerTeamIds: ownerTeams };

      const teamNames = new Map(
        (await this.repository.listTeams(tx, actor.tenantId)).map((team) => [team.id, team.name]),
      );

      const explained = people.flatMap((member) => {
        const personActor = actors.get(member.userId);
        if (personActor === undefined) return [];

        const access = explainRecordAccess(personActor, 'read', objectType, ref);
        const visibilities = access.allowed
          ? fields.map((field) => explainFieldVisibility(personActor, objectType, field.key))
          : [];

        return [
          {
            userId: member.userId,
            name: member.name,
            email: member.email,
            roleId: member.roleId,
            roleName: member.roleName,
            allowed: access.allowed,
            scope: access.scope,
            basis: access.basis,
            sharedTeamName:
              access.sharedTeamId === null ? null : (teamNames.get(access.sharedTeamId) ?? null),
            hiddenFields: visibilities
              .filter((visibility) => visibility.access === 'hidden')
              .map((visibility) => visibility.fieldKey),
            readOnlyFields: visibilities
              .filter((visibility) => visibility.access === 'read')
              .map((visibility) => visibility.fieldKey),
          },
        ];
      });

      // Those who can see it first, then alphabetical: the question was "who can".
      explained.sort(
        (a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name),
      );

      let owner: RecordAccess['owner'] = null;
      if (record.ownerId !== null) {
        const known = people.find((member) => member.userId === record.ownerId);
        owner = {
          userId: record.ownerId,
          name:
            known?.name ??
            (await this.repository.userNames(tx, actor.tenantId, [record.ownerId])).get(
              record.ownerId,
            )?.name ??
            null,
        };
      }

      return { objectType, id, owner, fields, people: explained, truncated };
    });
  }

  /** What this person can reach. */
  async memberReach(actor: Actor, userId: string): Promise<Reach> {
    this.assertAdministrator(actor);

    return this.inTenant(actor, async (tx) => {
      const member = await this.repository.findMember(tx, actor.tenantId, userId);
      if (member === null) throw new NotFoundError('Member');

      // A suspended member cannot act at all: the same empty actor a request
      // would be refused with, so every cell reads "no access".
      const subject =
        member.status === 'active'
          ? ((await loadActors(tx, actor.tenantId, [userId])).get(userId) ?? null)
          : null;
      const personActor: Actor = subject ?? {
        userId: userId as Actor['userId'],
        tenantId: actor.tenantId,
        teamIds: [],
        permissions: compilePermissions([], []),
      };

      return this.reach(tx, actor, personActor, {
        kind: 'member',
        id: userId,
        name: member.name,
        roleName: member.roleName,
      });
    });
  }

  /** What holders of a role can reach, without record counts. */
  async roleReach(actor: Actor, roleId: string): Promise<Reach> {
    this.assertAdministrator(actor);

    return this.inTenant(actor, async (tx) => {
      const role = await this.repository.findRole(tx, actor.tenantId, roleId);
      if (role === null) throw new NotFoundError('Role');

      const state = await this.repository.loadPermissionState(tx, actor.tenantId, roleId);
      const personActor: Actor = {
        // Scope is reported, never applied to a person, so whose id this is
        // does not matter; the viewer's is a harmless stand-in.
        userId: actor.userId,
        tenantId: actor.tenantId,
        teamIds: [],
        permissions: compilePermissions(
          state.grants.map((cell) => ({ ...cell, roleId: roleId as never })),
          state.fieldRules.map((cell) => ({ ...cell, roleId: roleId as never })),
        ),
      };

      return this.reach(
        tx,
        actor,
        personActor,
        { kind: 'role', id: roleId, name: role.name, roleName: role.name },
        { withCounts: false },
      );
    });
  }

  // -------------------------------------------------------------------------

  private async reach(
    tx: Tx,
    viewer: Actor,
    subject: Actor,
    identity: Reach['subject'],
    options: { withCounts: boolean } = { withCounts: true },
  ): Promise<Reach> {
    const resolved = await this.support.catalogue(tx, viewer.tenantId);

    const reach = explainReach(
      subject,
      resolved.objects.map((object) => ({
        objectType: object.objectType as ObjectType,
        fieldKeys:
          object.kind === 'record'
            ? object.fields
                // Only fields the viewer can read: a hidden field is not discussed.
                .filter((field) => canReadField(viewer, object.objectType as ObjectType, field.key))
                .map((field) => field.key)
            : [],
      })),
      ['read', 'create', 'update', 'delete', 'export', 'import'],
    );

    const counter = this.support.countFor(tx, viewer.tenantId);
    const roleNames = new Map(
      (await this.repository.listRoles(tx, viewer.tenantId)).map((role) => [role.id, role.name]),
    );

    const objects: Reach['objects'] = [];
    for (const entry of reach) {
      const definition = resolved.objects.find((object) => object.objectType === entry.objectType);
      if (definition === undefined) continue;

      const labels = new Map(definition.fields.map((field) => [field.key, field.label]));
      const read = entry.actions.find((action) => action.action === 'read');

      objects.push({
        objectType: entry.objectType,
        kind: definition.kind,
        actions: entry.actions
          .filter((action) => definition.actions.includes(action.action))
          .map((action) => ({
            action: action.action,
            allowed: action.allowed,
            scope: action.scope,
            viaRoleName: action.viaRoleId === null ? null : (roleNames.get(action.viaRoleId) ?? null),
          })),
        readableRecords:
          options.withCounts && read?.allowed === true && this.support.mayCount(viewer, entry.objectType)
            ? await counter(subject, 'read', entry.objectType)
            : null,
        fields: entry.fields.map((field) => ({
          key: field.fieldKey,
          label: labels.get(field.fieldKey) ?? field.fieldKey,
          access: field.access,
          narrowedBy: field.narrowedBy,
        })),
      });
    }

    return { subject: identity, objects };
  }

  /** `role:read` and `membership:read`: the people who may read the configuration. */
  private assertAdministrator(actor: Actor): void {
    assertCan(actor, 'read', { objectType: 'role' });
    assertCan(actor, 'read', { objectType: 'membership' });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
