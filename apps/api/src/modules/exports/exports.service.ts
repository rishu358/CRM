import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  ConflictError,
  GENERATED_FILE_RETENTION_HOURS,
  isStandardQueryColumn,
  newId,
  NotFoundError,
  PRESIGNED_URL_TTL_SECONDS,
  QUERY_COLUMNS,
  TAGS_FILTER_FIELD,
  sortableFieldKeys,
  ValidationError,
  type Actor,
  type FieldDefinition,
  type StorageProvider,
} from '@crm/core';
import {
  parseFilter,
  parseSort,
  toFilterList,
  type DownloadLink,
  type ExportCreateInput,
  type ExportJob as ExportJobContract,
} from '@crm/contracts';
import type { ExportJob, Tx } from '@crm/db';
import { newStorageKey } from '@crm/storage';
import { assertFiltersReadable, assertSortable } from '../../common/field-queries.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { STORAGE_PROVIDER } from '../../platform/storage/storage.tokens.js';
import { ExportsRepository } from './exports.repository.js';

function serializeExportJob(job: ExportJob): ExportJobContract {
  return {
    id: job.id,
    objectType: job.objectType,
    status: job.status,
    format: job.format,
    rowCount: job.rowCount ?? null,
    sizeBytes: job.sizeBytes ?? null,
    failureReason: job.failureReason ?? null,
    expiresAt: job.expiresAt.toISOString(),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/**
 * Export orchestration on the request side (MVP_SPEC §M8, ADR-0029).
 *
 * An export is a list query that runs to completion in the worker, so this
 * service's job is to make sure that, by the time it is queued, the query is
 * one the **list endpoint would have accepted from this caller**: the sort and
 * filter fields must exist and be readable by them. Validating here means a
 * bad filter is an immediate 422 on the request, not a failed job minutes
 * later — and means the worker never runs a query nobody authorized.
 *
 * The worker then re-derives the caller's permissions itself and applies them
 * to every row, so this check being skipped would be a bug and not a leak. It
 * is the same belt-and-braces the record modules apply between the service and
 * RLS.
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ExportsRepository) private readonly repository: ExportsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async create(
    actor: Actor,
    input: ExportCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<ExportJobContract> {
    // `export` is its own action, separate from `read`: a Read-only role can see
    // the pipeline and cannot walk out with the customer list (MVP_SPEC §4).
    assertCan(actor, 'export', { objectType: input.objectType });

    return this.inTenant(actor, async (tx) => {
      // After `can()`, so someone who may not export is told so before learning anything about the
      // plan. Before the idempotent replay too: a withdrawn feature starts no new job, even a repeat.
      await this.entitlements.require(tx, actor.tenantId, 'exports');

      if (idempotencyKey !== undefined) {
        const existing = await this.repository.findByIdempotencyKey(
          tx,
          actor.tenantId,
          actor.userId,
          idempotencyKey,
        );
        if (existing !== null) return serializeExportJob(existing);
      }

      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, input.objectType);
      const filters = toFilterList(input.filter);
      this.validateQuery(actor, input, filters, fields);

      const expiresAt = new Date(Date.now() + GENERATED_FILE_RETENTION_HOURS * 3_600_000);
      const inserted = await this.repository.insert(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        objectType: input.objectType,
        status: 'queued',
        format: input.format,
        query: {
          ...(filters.length === 0 ? {} : { filter: filters }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.q === undefined || input.q === '' ? {} : { q: input.q }),
        },
        storageKey: newStorageKey(actor.tenantId, 'exports'),
        expiresAt,
        idempotencyKey: idempotencyKey ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      if (inserted === null) {
        const winner =
          idempotencyKey === undefined
            ? null
            : await this.repository.findByIdempotencyKey(
                tx,
                actor.tenantId,
                actor.userId,
                idempotencyKey,
              );
        if (winner === null) throw new ConflictError('Could not create the export');
        return serializeExportJob(winner);
      }

      // Audited when it is *asked for*, with what was asked (CLAUDE.md §5.11).
      // The worker audits again with the row count when it finishes, and the API
      // audits each download link: three events for one export, because each is
      // a different moment at which the data could have left.
      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: input.objectType,
        recordId: inserted.id,
        changes: {
          format: { new: input.format },
          filter: { new: filters },
          sort: { new: input.sort ?? null },
          q: { new: input.q ?? null },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'export.requested.v1',
        objectType: 'export_job',
        recordId: inserted.id,
      });

      return serializeExportJob(inserted);
    });
  }

  async get(actor: Actor, id: string): Promise<ExportJobContract> {
    return this.inTenant(actor, async (tx) => {
      const job = await this.loadOwn(tx, actor, id);
      assertCan(actor, 'export', { objectType: job.objectType });
      return serializeExportJob(job);
    });
  }

  /** The moment the data leaves. Re-checks permission, then audits, then signs. */
  async downloadLink(actor: Actor, id: string): Promise<DownloadLink> {
    const job = await this.inTenant(actor, async (tx) => {
      const found = await this.loadOwn(tx, actor, id);
      // Permission is judged again now, not when the export was queued: a role
      // revoked in between means the link is not issued.
      assertCan(actor, 'export', { objectType: found.objectType });

      if (found.expiresAt.getTime() <= Date.now()) throw new NotFoundError('Export');
      if (found.status !== 'completed') {
        throw new ConflictError(
          found.status === 'failed' ? 'This export failed' : 'This export is not ready yet',
        );
      }

      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: found.objectType,
        recordId: found.id,
        changes: { download: { new: 'link issued' }, rowCount: { new: found.rowCount } },
      });
      return found;
    });

    const link = await this.storage.createDownloadUrl({
      key: job.storageKey,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.download,
      fileName: `${job.objectType}s-${job.id.slice(0, 8)}.${job.format}`,
      contentType: CONTENT_TYPES[job.format],
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  private validateQuery(
    actor: Actor,
    input: ExportCreateInput,
    rawFilters: readonly string[],
    fields: readonly FieldDefinition[],
  ): void {
    const objectType = input.objectType;
    const customKeys = fields
      .filter((field) => field.isActive && !field.isSystem)
      .map((field) => field.key);
    const knownKeys = new Set([
      ...Object.keys(QUERY_COLUMNS[objectType]),
      TAGS_FILTER_FIELD,
      ...customKeys,
    ]);

    if (input.sort !== undefined) {
      const sort = parseSort(input.sort);
      const allowed = [
        ...Object.keys(QUERY_COLUMNS[objectType]),
        ...sortableFieldKeys(fields).filter(
          (key) => !isStandardQueryColumn(objectType, key) && customKeys.includes(key),
        ),
      ];
      assertSortable(actor, objectType, sort.field, allowed);
    }

    const parsed = rawFilters.map((raw) => {
      const filter = parseFilter(raw);
      if (filter === null) {
        throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
      }
      return filter;
    });
    assertFiltersReadable(actor, objectType, parsed);
    for (const filter of parsed) {
      if (!knownKeys.has(filter.field)) {
        throw new ValidationError([{ path: filter.field, message: 'Unknown field' }]);
      }
    }
  }

  private async loadOwn(tx: Tx, actor: Actor, id: string): Promise<ExportJob> {
    const job = await this.repository.findOwn(tx, actor.tenantId, actor.userId, id);
    if (job === null) throw new NotFoundError('Export');
    return job;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
