import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  can,
  ConflictError,
  ForbiddenError,
  newId,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  VIEW_MAX_PER_OBJECT_PER_USER,
  type Actor,
  type BusinessObjectType,
  type FieldDefinition,
} from '@crm/core';
import {
  viewFiltersSchema,
  type SavedView as SavedViewDto,
  type SavedViewCreateInput,
  type SavedViewListQuery,
  type SavedViewUpdateInput,
  type ViewFilters,
  type ViewSort,
} from '@crm/contracts';
import type { SavedView as SavedViewRow, Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { assertViewQuery, readableViewColumns, viewIsApplicable } from '../../common/view-query.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { SavedViewsRepository } from './saved-views.repository.js';

const NAME_KEY = 'saved_views_tenant_object_name_owner_key';

/**
 * Saved views (MVP_SPEC M4, ADR-0056).
 *
 * A view is the state of a list under a name. Four rules make it safe to share:
 *
 *  1. **Reading a view needs `read` on its object type.** A view of deals is a description of the
 *     deals list; somebody who cannot open that list gets 403 for the views too.
 *  2. **A view can only name fields its author could read, and is judged again for each reader.**
 *     Saving one that filters on a hidden field is a 422 ("Unknown field", the list endpoint's own
 *     answer). A shared view that uses a field the *reader* cannot read is listed as
 *     `applicable: false` without saying which field, and its unreadable columns are dropped.
 *  3. **Sharing is a grant.** Private is always allowed. `team` needs the author to be in a team.
 *     `tenant` needs `update` on `tenant_settings`, the same grant that renames the company, so
 *     it is a row in the permission matrix and not a role name (CLAUDE.md §5.3).
 *  4. **Visibility is also enforced by the database** (migration 0023), so a bug here cannot
 *     show somebody's private view to a colleague.
 *
 * Applying a view is not an endpoint: the client sends the view's search, conditions and sort to
 * the ordinary list endpoint, which validates them again against the reader's permissions. A view
 * therefore cannot widen what anybody can read.
 */
@Injectable()
export class SavedViewsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SavedViewsRepository) private readonly repository: SavedViewsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(actor: Actor, query: SavedViewListQuery): Promise<SavedViewDto[]> {
    assertCan(actor, 'read', { objectType: query.objectType });

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, query.objectType);
      const rows = await this.repository.list(tx, actor.tenantId, query.objectType);
      return rows
        .map((row) => this.present(actor, row, fields))
        .sort((a, b) => Number(b.isMine) - Number(a.isMine));
    });
  }

  async create(actor: Actor, input: SavedViewCreateInput): Promise<SavedViewDto> {
    assertCan(actor, 'read', { objectType: input.objectType });
    this.assertMaySetVisibility(actor, input.visibility);

    return this.inTenant(actor, async (tx) => {
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, input.objectType);
      assertViewQuery(actor, input.objectType, fields, {
        conditions: input.filters.conditions,
        sort: input.sort,
        columns: input.columns,
      });

      const owned = await this.repository.countOwn(
        tx,
        actor.tenantId,
        actor.userId,
        input.objectType,
      );
      if (owned >= VIEW_MAX_PER_OBJECT_PER_USER) {
        throw new ValidationError([
          {
            path: 'name',
            message: `You can keep up to ${VIEW_MAX_PER_OBJECT_PER_USER} views of one kind. Delete one first.`,
          },
        ]);
      }

      const row = await this.translateDuplicateName(() =>
        this.repository.insert(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          objectType: input.objectType,
          name: input.name,
          visibility: input.visibility,
          filters: normalizeFilters(input.filters),
          columns: input.columns,
          sort: input.sort,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        }),
      );

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'saved_view',
        recordId: row.id,
        changes: {
          name: { new: row.name },
          objectType: { new: row.objectType },
          visibility: { new: row.visibility },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'saved_view.created.v1',
        objectType: 'saved_view',
        recordId: row.id,
        payload: { viewObjectType: row.objectType, visibility: row.visibility },
      });

      return this.present(actor, row, fields);
    });
  }

  async update(actor: Actor, id: string, input: SavedViewUpdateInput): Promise<SavedViewDto> {
    return this.inTenant(actor, async (tx) => {
      const existing = await this.loadOwn(tx, actor, id);
      const objectType = existing.objectType as BusinessObjectType;
      assertCan(actor, 'read', { objectType });
      if (input.visibility !== undefined) this.assertMaySetVisibility(actor, input.visibility);

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, objectType);
      const filters = input.filters ?? readFilters(existing.filters);
      const sort = input.sort ?? readSort(existing.sort);
      const columns = input.columns ?? [...existing.columns];

      // Judged against what is being saved, not only what changed: an edit to the name of a view
      // that already uses a field the author can no longer read must not slip through unchecked,
      // and one that fixes it must be allowed.
      assertViewQuery(actor, objectType, fields, {
        conditions: filters.conditions,
        sort,
        columns,
      });

      const updated = await this.translateDuplicateName(() =>
        this.repository.updateWithVersion(tx, actor.tenantId, actor.userId, id, input.version, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          ...(input.filters === undefined ? {} : { filters: normalizeFilters(input.filters) }),
          ...(input.columns === undefined ? {} : { columns: input.columns }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          updatedBy: actor.userId,
        }),
      );
      // The row is ours and we just read it, so no row back means the version moved.
      if (updated === null) throw new VersionConflictError('saved view');

      const changes: Record<string, { old?: unknown; new?: unknown }> = {};
      if (existing.name !== updated.name) {
        changes['name'] = { old: existing.name, new: updated.name };
      }
      if (existing.visibility !== updated.visibility) {
        changes['visibility'] = { old: existing.visibility, new: updated.visibility };
      }
      if (JSON.stringify(existing.filters) !== JSON.stringify(updated.filters)) {
        changes['filters'] = { old: existing.filters, new: updated.filters };
      }
      if (JSON.stringify(existing.columns) !== JSON.stringify(updated.columns)) {
        changes['columns'] = { old: existing.columns, new: updated.columns };
      }
      if (JSON.stringify(existing.sort) !== JSON.stringify(updated.sort)) {
        changes['sort'] = { old: existing.sort, new: updated.sort };
      }

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'saved_view',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'saved_view.updated.v1',
        objectType: 'saved_view',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });

      return this.present(actor, updated, fields);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    await this.inTenant(actor, async (tx) => {
      const existing = await this.loadOwn(tx, actor, id);

      const deleted = await this.repository.deleteWithVersion(
        tx,
        actor.tenantId,
        actor.userId,
        id,
        version,
      );
      if (!deleted) throw new VersionConflictError('saved view');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'saved_view',
        recordId: id,
        changes: { name: { old: existing.name } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'saved_view.deleted.v1',
        objectType: 'saved_view',
        recordId: id,
        payload: { viewObjectType: existing.objectType },
      });
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The view, if the caller may see it **and** it is theirs.
   *
   * What the caller cannot see does not exist (404, and the database agrees). What they can see
   * but did not make is somebody's shared work: they know it exists, so the honest answer is 403.
   */
  private async loadOwn(tx: Tx, actor: Actor, id: string): Promise<SavedViewRow> {
    const row = await this.repository.findById(tx, actor.tenantId, id);
    if (row === null) throw new NotFoundError('Saved view');
    if (row.createdBy !== actor.userId) throw new ForbiddenError();
    return row;
  }

  private assertMaySetVisibility(actor: Actor, visibility: 'private' | 'team' | 'tenant'): void {
    if (visibility === 'private') return;
    if (visibility === 'team') {
      if (actor.teamIds.length === 0) {
        throw new ValidationError([
          {
            path: 'visibility',
            message: 'You are not on a team, so there is no team to share with',
          },
        ]);
      }
      return;
    }
    // Everyone in the workspace: a decision about the workspace, not about one's own list.
    if (!can(actor, 'update', { objectType: 'tenant_settings' }).allowed) {
      throw new ForbiddenError('Only an administrator can share a view with everyone');
    }
  }

  private present(
    actor: Actor,
    row: SavedViewRow,
    fields: readonly FieldDefinition[],
  ): SavedViewDto {
    const objectType = row.objectType as BusinessObjectType;
    const stored = { filters: readFilters(row.filters), sort: readSort(row.sort) };
    const applicable = viewIsApplicable(actor, objectType, fields, {
      conditions: stored.filters.conditions,
      sort: stored.sort,
    });
    // A view this reader cannot use is shown without its filter and sort: they would name the very
    // field (and its value) that is hidden from them.
    const filters: ViewFilters = applicable ? stored.filters : { conditions: [] };
    const sort = applicable ? stored.sort : [];
    return {
      id: row.id,
      objectType,
      name: row.name,
      visibility: row.visibility as ViewVisibilityDto,
      filters,
      columns: readableViewColumns(actor, objectType, fields, row.columns),
      sort,
      isMine: row.createdBy === actor.userId,
      applicable,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async translateDuplicateName<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isConstraintViolation(error, NAME_KEY)) {
        throw new ConflictError('You already have a view with that name', [
          { path: 'name', message: 'You already have a view with that name' },
        ]);
      }
      throw error;
    }
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

type ViewVisibilityDto = SavedViewDto['visibility'];

/** Store `q` only when there is one, so equal views serialize equally. */
function normalizeFilters(filters: ViewFilters): Record<string, unknown> {
  return {
    ...(filters.q === undefined || filters.q.length === 0 ? {} : { q: filters.q }),
    conditions: filters.conditions,
  };
}

/** A stored filters value, re-parsed: a row written by an older shape reads as empty, not as a crash. */
function readFilters(stored: unknown): ViewFilters {
  const parsed = viewFiltersSchema.safeParse(stored);
  return parsed.success ? parsed.data : { conditions: [] };
}

function readSort(stored: unknown): ViewSort[] {
  if (!Array.isArray(stored)) return [];
  const sorts: ViewSort[] = [];
  for (const entry of stored as unknown[]) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { field?: unknown }).field === 'string' &&
      ['asc', 'desc'].includes((entry as { direction?: unknown }).direction as string)
    ) {
      sorts.push({
        field: (entry as ViewSort).field,
        direction: (entry as ViewSort).direction,
      });
    }
  }
  return sorts;
}
