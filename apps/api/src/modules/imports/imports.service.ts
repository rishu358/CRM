import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  claimedFormatFromFileName,
  ConflictError,
  IMPORT_LIMITS,
  importTargets,
  MATCH_FIELDS,
  newId,
  NotFoundError,
  PRESIGNED_URL_TTL_SECONDS,
  ValidationError,
  validateMapping,
  type Actor,
  type ImportableObjectType,
  type StorageProvider,
} from '@crm/core';
import type {
  DownloadLink,
  ImportCreateInput,
  ImportJob as ImportJobContract,
  ImportListQuery,
  ImportStartInput,
} from '@crm/contracts';
import type { ImportJob, Tx } from '@crm/db';
import { newStorageKey } from '@crm/storage';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { STORAGE_PROVIDER } from '../../platform/storage/storage.tokens.js';
import { ImportsRepository } from './imports.repository.js';
import { serializeImportJob } from './imports.serializer.js';

/** What a presigned upload is bound to, decided here and never by the client. */
const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export interface ImportCreateResult {
  readonly job: ImportJobContract;
  readonly upload: {
    readonly url: string;
    readonly method: 'PUT';
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  } | null;
}

/**
 * Import orchestration on the request side (MVP_SPEC §M8, ADR-0029).
 *
 * The API does four things for an import and never a fifth. It records that a
 * file is expected, hands the browser a place to put it, records that it
 * arrived, and records the mapping the user chose. **It never reads the file**:
 * parsing, type detection, limits and writing all happen in the worker, so a
 * hostile upload can exhaust a worker that restarts and cannot touch a request
 * handler that serves everyone else (CLAUDE.md §5.12).
 *
 * Every method authorizes before it touches a job, and every job lookup is by
 * the creator as well as the id, so somebody else's import is a 404 (§5.5).
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ImportsRepository) private readonly repository: ImportsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async create(
    actor: Actor,
    input: ImportCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<ImportCreateResult> {
    assertCan(actor, 'import', { objectType: input.objectType });

    const claimed = claimedFormatFromFileName(input.fileName);
    if (claimed === null) {
      // The contract already refuses this; the service does not rely on that.
      throw new ValidationError([{ path: 'fileName', message: 'Upload a .csv or .xlsx file' }]);
    }

    const job = await this.inTenant(actor, async (tx) => {
      // After `can()`, and before the idempotent replay: a withdrawn feature starts no new import.
      await this.entitlements.require(tx, actor.tenantId, 'imports');

      if (idempotencyKey !== undefined) {
        const existing = await this.repository.findByIdempotencyKey(
          tx,
          actor.tenantId,
          actor.userId,
          idempotencyKey,
        );
        if (existing !== null) return existing;
      }

      const inserted = await this.repository.insert(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        objectType: input.objectType,
        status: 'awaiting_upload',
        fileName: input.fileName,
        claimedFormat: claimed,
        // Random, and never derived from anything the user typed (§5.12).
        storageKey: newStorageKey(actor.tenantId, 'imports'),
        sizeBytes: input.sizeBytes,
        idempotencyKey: idempotencyKey ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      if (inserted === null) {
        // Lost a race against an identical retry; that job is the answer.
        const winner =
          idempotencyKey === undefined
            ? null
            : await this.repository.findByIdempotencyKey(
                tx,
                actor.tenantId,
                actor.userId,
                idempotencyKey,
              );
        if (winner === null) throw new ConflictError('Could not create the import');
        return winner;
      }

      await this.audit.record(tx, actor, {
        action: 'import',
        objectType: 'import_job',
        recordId: inserted.id,
        changes: {
          objectType: { new: inserted.objectType },
          fileName: { new: inserted.fileName },
          sizeBytes: { new: inserted.sizeBytes },
        },
      });

      return inserted;
    });

    return { job: serializeImportJob(job), upload: await this.uploadFor(job, claimed) };
  }

  async list(
    actor: Actor,
    query: ImportListQuery,
  ): Promise<{
    data: ImportJobContract[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }> {
    this.assertCanImportSomething(actor);

    return this.inTenant(actor, async (tx) => {
      const result = await this.repository.listOwn(tx, actor.tenantId, actor.userId, {
        limit: query.limit,
        cursor: query.cursor,
      });
      return {
        data: result.rows.map((row) => serializeImportJob(row)),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
      };
    });
  }

  async get(actor: Actor, id: string): Promise<ImportJobContract> {
    this.assertCanImportSomething(actor);

    return this.inTenant(actor, async (tx) => {
      const job = await this.loadOwn(tx, actor, id);
      assertCan(actor, 'import', { objectType: job.objectType });

      if (job.status !== 'awaiting_mapping') return serializeImportJob(job);

      // Computed per caller from live metadata, so the screen can only ever
      // offer fields this person may write — and a field added a minute ago is
      // already there (ADR-0004). The API re-checks on `start`; this is the
      // courtesy, that is the control.
      const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, job.objectType);
      return serializeImportJob(job, {
        targets: importTargets(actor, job.objectType, fields),
        matchFields: MATCH_FIELDS[job.objectType],
      });
    });
  }

  /**
   * The browser says the upload finished.
   *
   * Idempotent, because a user double-clicks and a flaky network retries: a job
   * that has already moved on is returned as it is rather than refused.
   */
  async confirmUploaded(actor: Actor, id: string): Promise<ImportJobContract> {
    const job = await this.inTenant(actor, async (tx) => {
      const found = await this.loadOwn(tx, actor, id);
      assertCan(actor, 'import', { objectType: found.objectType });
      return found;
    });

    if (job.status !== 'awaiting_upload') return serializeImportJob(job);

    // Network I/O, so outside the transaction: a slow object store must not
    // hold a database connection.
    const stored = await this.storage.head(job.storageKey);
    if (stored === null) {
      throw new ConflictError('The file has not finished uploading');
    }

    const sizeMatches = stored.sizeBytes === job.sizeBytes;
    if (!sizeMatches || stored.sizeBytes > IMPORT_LIMITS.maxUploadBytes) {
      return this.reject(
        actor,
        job,
        'The uploaded file is not the size that was declared, so it was refused',
      );
    }

    return this.inTenant(actor, async (tx) => {
      const moved = await this.repository.transition(
        tx,
        actor.tenantId,
        job.id,
        'awaiting_upload',
        {
          status: 'analyzing',
          updatedBy: actor.userId,
        },
      );
      if (moved === null) {
        // Another request got there first; whatever it did is the truth now.
        return serializeImportJob(await this.loadOwn(tx, actor, id));
      }

      // Same transaction as the status change: the event exists if and only if
      // the job is analyzing (ADR-0006).
      await this.outbox.publish(tx, actor, {
        eventType: 'import.uploaded.v1',
        objectType: 'import_job',
        recordId: job.id,
      });
      return serializeImportJob(moved);
    });
  }

  /**
   * Everything that must be true before a file is run with this mapping, a real run or a check.
   * One function, so a check cannot accept a mapping the import itself would refuse.
   */
  private async assertRunnable(
    tx: Tx,
    actor: Actor,
    job: ImportJob,
    input: ImportStartInput,
  ): Promise<void> {
    // Collection-level checks first. An import creates records in every mode,
    // and updates them in one, so it needs those actions in its own right:
    // `import` is the door, `create` and `update` are what is behind it.
    assertCan(actor, 'import', { objectType: job.objectType });
    assertCan(actor, 'create', { objectType: job.objectType });
    if (input.duplicateMode === 'update') {
      assertCan(actor, 'update', { objectType: job.objectType });
    }

    if (job.status !== 'awaiting_mapping') {
      throw new ConflictError('This import is not waiting for a mapping');
    }
    const columns = job.columns ?? [];

    const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, job.objectType);
    const issues = validateMapping(actor, job.objectType, fields, input.mapping, {
      columnCount: columns.length,
      duplicateMode: input.duplicateMode,
      matchField: input.matchField ?? null,
    });
    if (issues.length > 0) {
      throw new ValidationError(
        issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
  }

  /**
   * Check a file against a mapping without importing it (ADR-0068).
   *
   * Makes a job of its own beside the one waiting for its mapping: same file, same mapping, same
   * duplicate rule, and `dry_run`. The worker runs every row through the real row logic and rolls
   * each chunk back, so what comes back is what an import would do and nothing was written. The
   * job being checked stays where it is, so the mapping can be changed and checked again, or
   * started for real.
   */
  async check(actor: Actor, id: string, input: ImportStartInput): Promise<ImportJobContract> {
    return this.inTenant(actor, async (tx) => {
      const job = await this.loadOwn(tx, actor, id);
      await this.assertRunnable(tx, actor, job, input);

      const checkId = newId();
      const created = await this.repository.insert(tx, {
        id: checkId,
        tenantId: actor.tenantId,
        objectType: job.objectType,
        status: 'staging',
        fileName: job.fileName,
        claimedFormat: job.claimedFormat,
        detectedFormat: job.detectedFormat,
        // The same stored file. The check never deletes it: only the import that is run for real does.
        storageKey: job.storageKey,
        sizeBytes: job.sizeBytes,
        columns: job.columns,
        mapping: input.mapping.map((entry) => ({ column: entry.column, field: entry.field })),
        duplicateMode: input.duplicateMode,
        matchField: input.duplicateMode === 'create' ? null : (input.matchField ?? null),
        dryRun: true,
        startedAt: new Date(),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      if (created === null) throw new ConflictError('This check could not be started');

      await this.audit.record(tx, actor, {
        action: 'import',
        objectType: 'import_job',
        recordId: created.id,
        changes: {
          dryRun: { new: true },
          checkedJobId: { new: job.id },
          ...(input.mapping.some((entry) => entry.field === 'created_at')
            ? { originalDates: { new: true } }
            : {}),
          duplicateMode: { new: created.duplicateMode },
          mappedFields: { new: input.mapping.map((entry) => entry.field) },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'import.started.v1',
        objectType: 'import_job',
        recordId: created.id,
      });
      return serializeImportJob(created);
    });
  }

  async start(actor: Actor, id: string, input: ImportStartInput): Promise<ImportJobContract> {
    return this.inTenant(actor, async (tx) => {
      const job = await this.loadOwn(tx, actor, id);
      await this.assertRunnable(tx, actor, job, input);

      const moved = await this.repository.transition(
        tx,
        actor.tenantId,
        job.id,
        'awaiting_mapping',
        {
          status: 'staging',
          mapping: input.mapping.map((entry) => ({ column: entry.column, field: entry.field })),
          duplicateMode: input.duplicateMode,
          matchField: input.duplicateMode === 'create' ? null : (input.matchField ?? null),
          startedAt: new Date(),
          updatedBy: actor.userId,
        },
      );
      if (moved === null) throw new ConflictError('This import is not waiting for a mapping');

      await this.audit.record(tx, actor, {
        action: 'import',
        objectType: 'import_job',
        recordId: job.id,
        changes: {
          status: { old: job.status, new: moved.status },
          duplicateMode: { new: moved.duplicateMode },
          mappedFields: { new: input.mapping.map((entry) => entry.field) },
          // Said on its own so "who brought history in" is one filter, not a read of every mapping.
          ...(input.mapping.some((entry) => entry.field === 'created_at')
            ? { originalDates: { new: true } }
            : {}),
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'import.started.v1',
        objectType: 'import_job',
        recordId: job.id,
      });

      return serializeImportJob(moved);
    });
  }

  /** A short-lived link to the error file. Issuing it is the audited event. */
  async errorFileLink(actor: Actor, id: string): Promise<DownloadLink> {
    const job = await this.inTenant(actor, async (tx) => {
      const found = await this.loadOwn(tx, actor, id);
      assertCan(actor, 'import', { objectType: found.objectType });
      if (found.errorFileKey === null) {
        throw new ConflictError('This import has no error file');
      }
      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: 'import_job',
        recordId: found.id,
        changes: { errorFile: { new: 'download link issued' } },
      });
      return found;
    });

    const link = await this.storage.createDownloadUrl({
      key: job.errorFileKey as string,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.download,
      fileName: `import-errors-${job.id}.csv`,
      contentType: 'text/csv',
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  private async uploadFor(
    job: ImportJob,
    claimed: 'csv' | 'xlsx',
  ): Promise<ImportCreateResult['upload']> {
    // A retry of `create` for a job that has moved on has nothing left to upload.
    if (job.status !== 'awaiting_upload' || job.sizeBytes === null) return null;

    const signed = await this.storage.createUploadUrl({
      key: job.storageKey,
      contentType: CONTENT_TYPES[claimed],
      sizeBytes: job.sizeBytes,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.upload,
    });
    return {
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  private async reject(actor: Actor, job: ImportJob, reason: string): Promise<ImportJobContract> {
    const rejected = await this.inTenant(actor, (tx) =>
      this.repository.transition(tx, actor.tenantId, job.id, 'awaiting_upload', {
        status: 'rejected',
        failureReason: reason,
        finishedAt: new Date(),
        updatedBy: actor.userId,
      }),
    );
    // Remove what was uploaded: a file we refused should not sit in the store.
    await this.storage.delete(job.storageKey);
    return serializeImportJob(rejected ?? job);
  }

  /** Needs `import` on at least one object type, or the whole feature is closed to them. */
  private assertCanImportSomething(actor: Actor): void {
    const types: readonly ImportableObjectType[] = ['account', 'contact', 'lead'];
    const allowed = types.some((objectType) => {
      try {
        assertCan(actor, 'import', { objectType });
        return true;
      } catch {
        return false;
      }
    });
    if (!allowed) assertCan(actor, 'import', { objectType: 'contact' });
  }

  private async loadOwn(tx: Tx, actor: Actor, id: string): Promise<ImportJob> {
    const job = await this.repository.findOwn(tx, actor.tenantId, actor.userId, id);
    if (job === null) throw new NotFoundError('Import');
    return job;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
