import { Inject, Injectable } from '@nestjs/common';
import {
  can,
  canWriteField,
  FieldNotWritableError,
  ForbiddenError,
  ValidationError,
  type Actor,
} from '@crm/core';
import {
  OWNED_OBJECTS,
  REASSIGN_MAX_PER_OBJECT,
  type OwnedObject,
  type ReassignInput,
  type ReassignPreview,
  type ReassignResult,
} from '@crm/contracts';
import {
  countReassignable,
  loadActors,
  reassignOwned,
  teamIdsByUser,
  type ReassignedRow,
  type Tx,
} from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { OwnershipRegistry } from '../../platform/ownership.registry.js';
import { AccessRepository } from './access.repository.js';

/** The field an object's owner is permissioned as (`STANDARD_FIELD_KEYS`, ADR-0026). */
const OWNER_FIELD: Readonly<Record<OwnedObject, string>> = {
  account: 'owner_id',
  contact: 'owner_id',
  lead: 'owner_id',
  deal: 'owner_id',
  activity: 'assigned_to',
};

/** Thrown to unwind a preview's transaction; carries the answer out of it. */
class RolledBack<T> {
  constructor(readonly value: T) {}
}

/**
 * Record ownership and reassignment, single and bulk (MVP_SPEC M3).
 *
 * Reassigning is an edit to every record it touches, so it is held to what an
 * edit is held to: the actor must hold `update` on the object, the owner field
 * must be writable to them, only records inside their `update` scope are
 * touched, each one's `version` moves, and each one is audited and announced
 * with the same `<object>.updated.v1` event an ordinary edit emits — so search
 * indexing, the timeline and notifications follow without knowing this exists.
 *
 * The assignment rules are the ones the modules apply to `ownerId` today
 * (`resolveOwner` in each service, `resolveAssignee` for activities), so this
 * endpoint is not a way around them: moving a record to another person needs
 * `all` scope; handing out an activity follows the actor's scope.
 *
 * ## The preview is the real thing, rolled back
 *
 * `preview` runs the same code as `reassign` inside a transaction it then
 * abandons. There is no separate counting query to drift from what would
 * actually happen, and the count is of records the actor could change — which
 * they could list anyway — so it reveals nothing they could not see.
 *
 * ## What a skipped record does not say
 *
 * A named record that does not move might be gone, outside the actor's scope,
 * or already the target's. The response counts them and does not say which
 * (CLAUDE.md §5.5): the alternative is an existence oracle.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessRepository) private readonly repository: AccessRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(OwnershipRegistry) private readonly registry: OwnershipRegistry,
  ) {}

  async preview(actor: Actor, input: ReassignInput): Promise<ReassignPreview> {
    try {
      await this.inTenant(actor, async (tx) => {
        const outcome = await this.run(tx, actor, input);
        throw new RolledBack(outcome);
      });
    } catch (error) {
      if (error instanceof RolledBack) {
        const outcome = (error as RolledBack<RunOutcome>).value;
        return {
          toOwner: outcome.toOwner,
          items: outcome.items.map((item) => ({
            objectType: item.objectType,
            willMove: item.moved.length,
            skipped: item.skipped,
          })),
        };
      }
      throw error;
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  }

  async reassign(actor: Actor, input: ReassignInput): Promise<ReassignResult> {
    return this.inTenant(actor, async (tx) => {
      const outcome = await this.run(tx, actor, input);
      return {
        moved: outcome.items
          .filter((item) => item.moved.length > 0)
          .map((item) => ({ objectType: item.objectType, count: item.moved.length })),
        skipped: outcome.items.reduce((sum, item) => sum + item.skipped, 0),
        remaining: outcome.remaining,
      };
    });
  }

  // -------------------------------------------------------------------------

  private async run(tx: Tx, actor: Actor, input: ReassignInput): Promise<RunOutcome> {
    const explicit = input.mode === 'records' || input.objectTypes !== undefined;
    const requested: readonly OwnedObject[] =
      input.mode === 'records' ? [input.objectType] : (input.objectTypes ?? OWNED_OBJECTS);

    // Authorize before looking at anything the caller named. If the target were
    // looked up first, "unknown member" would be told apart from "you may not
    // assign" and a caller with no right to reassign could learn which user ids
    // are members. So everything that depends only on the *actor* is settled
    // here, and only then is the person they named resolved.
    const permitted: OwnedObject[] = [];
    let firstRefusal: Error | null = null;
    for (const objectType of requested) {
      const refusal = this.actorRefusal(actor, objectType);
      if (refusal === null) {
        permitted.push(objectType);
        continue;
      }
      // Asked for by name: say so. Swept up in "everything they own": skip.
      if (explicit) throw refusal;
      firstRefusal ??= refusal;
    }
    if (permitted.length === 0) throw firstRefusal ?? new ForbiddenError();

    // The new owner must be somebody who can act in this workspace.
    const target = await this.repository.findMember(tx, actor.tenantId, input.toOwnerId);
    if (target === null || target.status !== 'active') {
      throw new ValidationError([{ path: 'toOwnerId', message: 'Unknown member' }]);
    }
    const targetActor = (await loadActors(tx, actor.tenantId, [input.toOwnerId])).get(
      input.toOwnerId,
    );
    if (targetActor === undefined) {
      throw new ValidationError([{ path: 'toOwnerId', message: 'Unknown member' }]);
    }
    const targetTeams =
      (await teamIdsByUser(tx, actor.tenantId, [input.toOwnerId])).get(input.toOwnerId) ?? [];

    const items: RunOutcome['items'] = [];
    let remaining = 0;

    for (const objectType of permitted) {
      const refusal = this.targetRefusal(actor, targetActor, objectType, targetTeams);
      if (refusal !== null) {
        if (explicit) throw refusal;
        continue;
      }

      const decision = can(actor, 'update', { objectType });
      if (!decision.allowed) continue; // unreachable: `actorRefusal` covered it

      const port = this.registry.get(objectType);
      if (port === undefined) throw new Error(`No ownership port registered for ${objectType}`);

      const selector =
        input.mode === 'records'
          ? { ids: [...new Set(input.recordIds)] }
          : { fromOwnerId: input.fromOwnerId };

      const moved = await reassignOwned(tx, port.table, {
        tenantId: actor.tenantId,
        updatedBy: actor.userId,
        toOwnerId: input.toOwnerId,
        constraint: decision.constraint,
        selector,
        limit: REASSIGN_MAX_PER_OBJECT,
      });

      for (const row of moved) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType,
          recordId: row.id,
          changes: { [OWNER_FIELD[objectType]]: { old: row.previousOwnerId, new: input.toOwnerId } },
        });
        await this.outbox.publish(tx, actor, {
          eventType: `${objectType}.updated.v1`,
          objectType,
          recordId: row.id,
          payload: { changedFields: [OWNER_FIELD[objectType]], reassigned: true },
        });
      }
      if (moved.length > 0 && port.afterReassign !== undefined) {
        await port.afterReassign(tx, actor, moved, input.toOwnerId);
      }

      items.push({
        objectType,
        moved,
        skipped: input.mode === 'records' ? new Set(input.recordIds).size - moved.length : 0,
      });

      if (input.mode === 'owner') {
        remaining += await countReassignable(tx, port.table, {
          tenantId: actor.tenantId,
          toOwnerId: input.toOwnerId,
          constraint: decision.constraint,
          fromOwnerId: input.fromOwnerId,
        });
      }
    }

    return { toOwner: { userId: target.userId, name: target.name }, items, remaining };
  }

  /**
   * Whether `actor` may reassign this kind of record **at all**, or why not.
   *
   * Depends on the actor alone, so it is settled before the target is looked
   * at. The rules are the ones the module services apply to `ownerId` /
   * `assignedTo` on an ordinary edit, evaluated through `can()`.
   */
  private actorRefusal(actor: Actor, objectType: OwnedObject): Error | null {
    const update = can(actor, 'update', { objectType });
    if (!update.allowed) return new ForbiddenError();

    if (!canWriteField(actor, objectType, OWNER_FIELD[objectType])) {
      return new FieldNotWritableError([OWNER_FIELD[objectType]]);
    }

    if (objectType === 'activity') {
      if (update.scope === 'own') {
        return new ValidationError([
          { path: 'toOwnerId', message: 'You cannot assign work to another user' },
        ]);
      }
    } else if (update.scope !== 'all') {
      return new ValidationError([
        { path: 'toOwnerId', message: 'You cannot assign records to another user' },
      ]);
    }
    return null;
  }

  /** Whether this particular person may be handed this kind of record. */
  private targetRefusal(
    actor: Actor,
    target: Actor,
    objectType: OwnedObject,
    targetTeams: readonly string[],
  ): Error | null {
    if (objectType === 'activity') {
      const update = can(actor, 'update', { objectType });
      if (
        update.allowed &&
        update.scope === 'team' &&
        !targetTeams.some((id) => actor.teamIds.includes(id as never))
      ) {
        return new ValidationError([
          { path: 'toOwnerId', message: 'You cannot assign work to that user' },
        ]);
      }
    }

    // A record handed to somebody who cannot see that kind of record would
    // vanish from everyone's view but an administrator's.
    if (!can(target, 'read', { objectType }).allowed) {
      return new ValidationError([
        { path: 'toOwnerId', message: 'That person cannot see this kind of record' },
      ]);
    }
    return null;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

interface RunOutcome {
  readonly toOwner: { userId: string; name: string };
  readonly items: {
    readonly objectType: OwnedObject;
    readonly moved: readonly ReassignedRow[];
    readonly skipped: number;
  }[];
  readonly remaining: number;
}
