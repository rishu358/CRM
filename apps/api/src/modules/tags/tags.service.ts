import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  can,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  VersionConflictError,
  type Actor,
  type BusinessObjectType,
} from '@crm/core';
import type { TagUpdateInput } from '@crm/contracts';
import {
  deleteTagWithVersion,
  findOtherTagByName,
  findTagById,
  listTags,
  listTagUsage,
  tagsForRecords,
  updateTagWithVersion,
  type RecordTagRef,
  type TagRef,
  type TagUsageRow,
  type Tx,
} from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';

/**
 * Tags: the workspace's list, the settings screen, and the chips a record carries (ADR-0063).
 *
 * Owns `tags` and `record_tags`. Adding a tag to a record and removing it are the bulk module's
 * `tag_add` and `tag_remove` (ADR-0056) with one id, so there is one write path for that and one
 * place that enforces the cap. What lives here is what that path does not give:
 *
 *   - **reading**: `list` for the picker, and `tagsFor`, the method the contact, account, lead and
 *     deal services call to put `tags` on a record and on each row of a list. It is handed ids the
 *     caller has already loaded under their own record scope, so a tag is never reported for a record
 *     they cannot see.
 *   - **managing**: rename, recolour and delete are a decision about the workspace, not about one
 *     record, so they need `update` on `tenant_settings`, the grant that already guards sharing a view
 *     with everyone (ADR-0056). It is a row in the permission matrix, not a role name (CLAUDE.md §5.3),
 *     and it needed no new catalogue entry and no backfill of every existing role.
 *
 * Tags are configuration, like saved views and pipelines: a hard delete, a `version` for the screen's
 * edits, one audit entry and one event per change. Deleting a tag removes it from every record
 * (the foreign key cascades) and writes **one** audit entry and event for the tag, with how many
 * records it was on, and not one per record: a tag on a hundred thousand records would otherwise be
 * a hundred thousand rows in one request (ADR-0063).
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /** The workspace's tags, for the picker. Anyone who may read a record kind may see the names. */
  async list(actor: Actor): Promise<TagRef[]> {
    const mayRead = (['contact', 'account', 'lead', 'deal'] as const).some(
      (objectType) => can(actor, 'read', { objectType }).allowed,
    );
    if (!mayRead) throw new ForbiddenError();
    return this.inTenant(actor, (tx) => listTags(tx, actor.tenantId));
  }

  /** Every tag with how many live records of each kind carry it. Managers only: it counts every record. */
  async usage(actor: Actor): Promise<TagUsageRow[]> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    return this.inTenant(actor, (tx) => listTagUsage(tx, actor.tenantId));
  }

  async update(actor: Actor, id: string, input: TagUpdateInput): Promise<TagRef> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const existing = await findTagById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Tag');

      if (input.name !== undefined && input.name.toLowerCase() !== existing.name.toLowerCase()) {
        const clash = await findOtherTagByName(tx, actor.tenantId, input.name, id);
        if (clash !== null) {
          throw new ConflictError('A tag with that name already exists');
        }
      }

      const updated = await this.updateOrNameTaken(tx, {
        tenantId: actor.tenantId,
        id,
        version: input.version,
        userId: actor.userId,
        patch: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
        },
      });
      // The row exists (it was just read), so a zero-row update means the version moved.
      if (updated === null) throw new VersionConflictError('tag');

      const changes: Record<string, { old?: unknown; new?: unknown }> = {};
      if (input.name !== undefined && input.name !== existing.name) {
        changes['name'] = { old: existing.name, new: updated.name };
      }
      if (input.color !== undefined && input.color !== existing.color) {
        changes['color'] = { old: existing.color, new: updated.color };
      }
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'tag',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'tag.updated.v1',
        objectType: 'tag',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });
      return updated;
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    await this.inTenant(actor, async (tx) => {
      const existing = await findTagById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Tag');
      if (existing.version !== version) throw new VersionConflictError('tag');

      const usage = (await listTagUsage(tx, actor.tenantId)).find((row) => row.id === id);
      const recordsAffected = usage === undefined ? 0 : sum(Object.values(usage.records));

      const deleted = await deleteTagWithVersion(tx, { tenantId: actor.tenantId, id, version });
      if (!deleted) throw new VersionConflictError('tag');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'tag',
        recordId: id,
        changes: { name: { old: existing.name }, recordsAffected: { old: recordsAffected } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'tag.deleted.v1',
        objectType: 'tag',
        recordId: id,
        payload: { recordsAffected },
      });
    });
  }

  /**
   * The tags on each of `ids`, for a record page or a page of a list.
   *
   * The public method the four object services call inside their own transaction (ADR-0001), with
   * ids they loaded under the reader's record scope. One query for the lot.
   */
  async tagsFor(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    ids: readonly string[],
  ): Promise<Map<string, RecordTagRef[]>> {
    return tagsForRecords(tx, actor.tenantId, objectType, ids);
  }

  /**
   * `records` with a `tags` list added to each, in one query.
   *
   * What the four record services call on their serialized output: `records` has already been through
   * the field-permission serializer, and tags are not a field (ADR-0063), so they are added after it.
   */
  async attach<T extends { readonly [key: string]: unknown }>(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    records: readonly T[],
  ): Promise<(T & { readonly tags: RecordTagRef[] })[]> {
    const byRecord = await this.tagsFor(
      tx,
      actor,
      objectType,
      records.map((record) => record['id'] as string),
    );
    return records.map((record) => ({
      ...record,
      tags: byRecord.get(record['id'] as string) ?? [],
    }));
  }

  /** `attach` for one record. */
  async attachOne<T extends { readonly [key: string]: unknown }>(
    tx: Tx,
    actor: Actor,
    objectType: BusinessObjectType,
    record: T,
  ): Promise<T & { readonly tags: RecordTagRef[] }> {
    const byRecord = await this.tagsFor(tx, actor, objectType, [record['id'] as string]);
    return { ...record, tags: byRecord.get(record['id'] as string) ?? [] };
  }

  /**
   * The update, with the database's own "name taken" answered like the service's.
   *
   * The service looks for a clash first, so a person gets a clear 409 in the ordinary case; two renames
   * to the same name at the same moment both pass that look and the unique index (migration 0025) stops
   * the second. That must be the same 409, not a 500. A savepoint, so the failed statement does not
   * poison the request's transaction.
   */
  private async updateOrNameTaken(
    tx: Tx,
    args: Parameters<typeof updateTagWithVersion>[1],
  ): ReturnType<typeof updateTagWithVersion> {
    try {
      return await tx.transaction((savepoint) => updateTagWithVersion(savepoint, args));
    } catch (error) {
      if (isConstraintViolation(error, 'tags_tenant_lower_name_key')) {
        throw new ConflictError('A tag with that name already exists');
      }
      throw error;
    }
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
