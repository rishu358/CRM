import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  asInstant,
  canReadField,
  NotFoundError,
  RECYCLE_BIN_RETENTION_DAYS,
  ValidationError,
  VersionConflictError,
  type Actor,
  type SoftDeletableObjectType,
} from '@crm/core';
import type { RecycleBinEntry, RecycleBinListQuery, RecyclableObjectType } from '@crm/contracts';
import {
  descriptorFor,
  restoreDeleted,
  selectDeletedById,
  selectDeletedPage,
  teamIdsByUser,
  type DeletedRecordRow,
  type RecyclableDescriptor,
  type Tx,
} from '@crm/db';
import { decodeCursor, encodeCursor, type Cursor } from '../../common/cursor.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';

/**
 * The Recycle Bin (MVP_SPEC M4).
 *
 * "Soft delete → Recycle Bin (restore within 30 days, then hard delete by job)."
 *
 * Two things in here are easy to get wrong and are therefore spelled out:
 *
 * **Restore re-checks permission.** It does not inherit the right from whoever
 * deleted the record. The person restoring needs `delete` on the object type
 * *now* and the record must be inside their scope *now* — a rep whose access
 * was narrowed, or who changed team, cannot pull a record back into view that
 * they could no longer see. `delete` rather than `update` because restoring is
 * the inverse of deleting, and the permission model already has that verb for
 * "this record's existence is mine to decide".
 *
 * **The Bin obeys record scope.** Listing is `read` on the object type with the
 * scope constraint applied in SQL, so a rep on `own` scope never learns what a
 * colleague deleted. Both are asserted in `recycle-bin.security.spec.ts`.
 *
 * Restoring writes an audit entry and a domain event in the same transaction as
 * the update, like every other state change (CLAUDE.md §5.10, ADR-0006). The
 * event is what puts the record back into search and the timeline: the search
 * handler re-projects on `.restored.v1` exactly as it does on an update, so
 * nothing here has to know that a search index exists.
 */
@Injectable()
export class RecycleBinService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(
    actor: Actor,
    query: RecycleBinListQuery,
  ): Promise<{
    data: RecycleBinEntry[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }> {
    const objectType = query.objectType;
    // Reading the Bin is reading records, so it needs `read` on the object and
    // returns the constraint that becomes the WHERE clause.
    const decision = assertCan(actor, 'read', { objectType });

    const cursor = resolveCursor(query.cursor);

    return this.inTenant(actor, async (tx) => {
      const descriptor = descriptorFor(objectType);
      const rows = await selectDeletedPage(tx, actor.tenantId, descriptor, {
        constraint: decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
        limit: query.limit + 1,
        cursor,
      });

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];

      return {
        data: page.map((row) => serializeEntry(actor, objectType, descriptor, row)),
        meta: {
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({ value: last.cursor_value, id: last.id })
              : null,
          hasMore,
        },
      };
    });
  }

  async restore(
    actor: Actor,
    objectType: RecyclableObjectType,
    id: string,
    version: number,
  ): Promise<{ objectType: RecyclableObjectType; id: string; version: number }> {
    assertCan(actor, 'delete', { objectType });

    return this.inTenant(actor, async (tx) => {
      const descriptor = descriptorFor(objectType);
      const existing = await selectDeletedById(tx, actor.tenantId, descriptor, id);
      // Absent, live, in another tenant or out of scope all answer the same
      // way, so the endpoint is not an existence oracle (CLAUDE.md §5.5).
      if (existing === null) throw new NotFoundError(objectType);

      // `team` scope is a fact about the owner's teams, so the record must carry them. With the owner
      // alone a `team` grant can never match a teammate's record (pilot finding F3).
      const ownerTeamIds =
        existing.owner_id === null
          ? []
          : ((await teamIdsByUser(tx, actor.tenantId, [existing.owner_id])).get(
              existing.owner_id,
            ) ?? []);
      assertCan(actor, 'delete', {
        objectType,
        record: { ownerId: existing.owner_id, ownerTeamIds },
      });

      const restored = await restoreDeleted(
        tx,
        actor.tenantId,
        descriptor,
        id,
        version,
        actor.userId,
      );
      // The row exists — we just read it — so a zero-row update means the
      // version moved or somebody else restored it first. 409, never silent.
      if (restored === null) throw new VersionConflictError(objectType);

      await this.audit.record(tx, actor, {
        action: 'restore',
        objectType,
        recordId: id,
        changes: {
          // The date it was deleted on, as metadata about the event rather than
          // as a field of the record — `deletedAt` is not a field anybody holds
          // a permission on.
          restoredFrom: { new: asInstant(existing.deleted_at).toISOString() },
        },
      });

      // Re-index, re-timeline, re-notify: the same handlers an update drives.
      await this.outbox.publish(tx, actor, {
        eventType: `${objectType}.restored.v1`,
        objectType,
        recordId: id,
        payload: { ownerId: existing.owner_id },
      });

      return { objectType, id, version: restored.version };
    });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

/**
 * One deleted record, as the Bin lists it.
 *
 * The label is built **only** from fields this reader may read, so the Bin is
 * not a way around field permissions: a reader who cannot see `last_name` sees
 * "Contact", not a surname. When nothing is readable the object's own name is
 * the label, which is enough to decide whether to restore it and tells them
 * nothing they did not already know.
 */
function serializeEntry(
  actor: Actor,
  objectType: SoftDeletableObjectType,
  descriptor: RecyclableDescriptor,
  row: DeletedRecordRow,
): RecycleBinEntry {
  const parts = descriptor.labelColumns
    .filter((part) => canReadField(actor, objectType, part.fieldKey))
    .map((part) => row.label_parts[part.fieldKey])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const purgeAfter = new Date(
    asInstant(row.deleted_at).getTime() + RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    objectType,
    id: row.id,
    label: parts.length > 0 ? parts.join(' ') : FALLBACK_LABEL[objectType],
    ownerId: row.owner_id,
    deletedAt: asInstant(row.deleted_at).toISOString(),
    purgeAfter: purgeAfter.toISOString(),
    version: row.version,
  };
}

/** Said in English rather than as an object key, because a user reads it. */
const FALLBACK_LABEL: Readonly<Record<SoftDeletableObjectType, string>> = {
  account: 'Account',
  contact: 'Contact',
  lead: 'Lead',
  deal: 'Deal',
  activity: 'Activity',
};

function resolveCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) {
    throw new ValidationError([{ path: 'cursor', message: 'Malformed cursor' }]);
  }
  return cursor;
}
