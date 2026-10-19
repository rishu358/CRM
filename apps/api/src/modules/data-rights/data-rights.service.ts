import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  can,
  ConflictError,
  DATA_EXPORT_CAPABILITY,
  GENERATED_FILE_RETENTION_HOURS,
  newId,
  NotFoundError,
  PRESIGNED_URL_TTL_SECONDS,
  ValidationError,
  type Actor,
  type DataExportKind,
  type ErasableObjectType,
  type StorageProvider,
} from '@crm/core';
import type {
  DataExportCreateInput,
  DataExportJobContract,
  DownloadLink,
  ErasureCreateInput,
  ErasureListQuery,
  ErasureRequestContract,
} from '@crm/contracts';
import {
  descriptorFor,
  selectSubjectRecord,
  type DataExportJob,
  type ErasureRequest,
  type Tx,
} from '@crm/db';
import { newStorageKey } from '@crm/storage';
import { decodeCursor, encodeCursor, type Cursor } from '../../common/cursor.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { STORAGE_PROVIDER } from '../../platform/storage/storage.tokens.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { DataRightsRepository } from './data-rights.repository.js';

const CONTENT_TYPES = {
  json: 'application/json',
  csv: 'text/csv',
} as const;

/**
 * DPDP and GDPR data rights (MVP_SPEC M11).
 *
 * Four things a workspace owes the people in it, and the one capability each is
 * granted through:
 *
 *   | what                          | capability              | seeded to     |
 *   | ----------------------------- | ----------------------- | ------------- |
 *   | export the audit log          | `audit_log:export`      | Owner, Admin  |
 *   | export the whole workspace    | `tenant_data:export`    | Owner         |
 *   | export one person's data      | `data_subject:export`   | Owner, Admin  |
 *   | erase one person              | `data_subject:delete`   | Owner         |
 *
 * They are four separate grants rather than one `data_rights` capability
 * precisely so that letting an Admin answer a subject access request is not also
 * letting them download the company or erase a customer.
 *
 * Everything here is **queued, not done**: the API records the request, the
 * audit entry and the event, and the worker does the work — re-deriving the
 * caller's permissions when it runs, so a capability revoked in between means
 * no file and no erasure (the same contract `ExportsService` has, ADR-0029).
 */
@Injectable()
export class DataRightsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DataRightsRepository) private readonly repository: DataRightsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditLogService) private readonly auditLogs: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async createExport(
    actor: Actor,
    input: DataExportCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<DataExportJobContract> {
    const capability = DATA_EXPORT_CAPABILITY[input.kind].objectType;
    assertCan(actor, 'export', { objectType: capability });

    // An audit-log archive is the audit log. Someone who may export it but not
    // read it would otherwise get in a file what they are refused on screen,
    // which is the same leak with an extra step.
    if (input.kind === 'audit_log') this.auditLogs.assertMayRead(actor);

    const subject = input.kind === 'data_subject' ? requireSubject(input) : null;

    return this.inTenant(actor, async (tx) => {
      if (idempotencyKey !== undefined) {
        const existing = await this.repository.findExportByIdempotencyKey(
          tx,
          actor.tenantId,
          actor.userId,
          idempotencyKey,
        );
        if (existing !== null) return serializeExport(existing);
      }

      // A subject access request is about a record, so the caller must be able
      // to reach that record as well as hold the capability. 404 covers
      // "absent", "another tenant's" and "outside your scope" identically.
      if (subject !== null) {
        await this.assertSubjectReachable(tx, actor, subject.objectType, subject.recordId);
      }

      const inserted = await this.repository.insertExport(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        kind: input.kind,
        status: 'queued',
        format: input.format,
        params: {
          ...(input.kind === 'audit_log' ? (input.filters ?? {}) : {}),
          ...(subject === null
            ? {}
            : { subjectObjectType: subject.objectType, subjectRecordId: subject.recordId }),
        },
        storageKey: newStorageKey(actor.tenantId, 'data-exports'),
        expiresAt: new Date(Date.now() + GENERATED_FILE_RETENTION_HOURS * 3_600_000),
        idempotencyKey: idempotencyKey ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      if (inserted === null) {
        const winner =
          idempotencyKey === undefined
            ? null
            : await this.repository.findExportByIdempotencyKey(
                tx,
                actor.tenantId,
                actor.userId,
                idempotencyKey,
              );
        if (winner === null) throw new ConflictError('Could not create the archive');
        return serializeExport(winner);
      }

      // Audited when it is asked for, with what was asked. The worker audits
      // again with the row count, and the API audits each download link: three
      // moments at which the data could have left (CLAUDE.md §5.11).
      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: capability,
        recordId: inserted.id,
        changes: {
          format: { new: input.format },
          filter: { new: inserted.params },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'data_export.requested.v1',
        objectType: 'data_export_job',
        recordId: inserted.id,
      });

      return serializeExport(inserted);
    });
  }

  async getExport(actor: Actor, id: string): Promise<DataExportJobContract> {
    return this.inTenant(actor, async (tx) => {
      const job = await this.loadOwnExport(tx, actor, id);
      assertCan(actor, 'export', { objectType: DATA_EXPORT_CAPABILITY[job.kind].objectType });
      return serializeExport(job);
    });
  }

  /** The moment the data leaves. Re-checks the capability, audits, then signs. */
  async downloadLink(actor: Actor, id: string): Promise<DownloadLink> {
    const job = await this.inTenant(actor, async (tx) => {
      const found = await this.loadOwnExport(tx, actor, id);
      // Judged again now, not when the archive was queued: a capability revoked
      // in between means the link is not issued.
      assertCan(actor, 'export', { objectType: DATA_EXPORT_CAPABILITY[found.kind].objectType });
      if (found.kind === 'audit_log') this.auditLogs.assertMayRead(actor);

      if (found.expiresAt.getTime() <= Date.now()) throw new NotFoundError('Archive');
      if (found.status !== 'completed') {
        throw new ConflictError(
          found.status === 'failed' ? 'This archive failed' : 'This archive is not ready yet',
        );
      }

      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: DATA_EXPORT_CAPABILITY[found.kind].objectType,
        recordId: found.id,
        changes: { download: { new: 'link issued' }, rowCount: { new: found.rowCount } },
      });
      return found;
    });

    const link = await this.storage.createDownloadUrl({
      key: job.storageKey,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.download,
      fileName: `${job.kind}-${job.id.slice(0, 8)}.${job.format}`,
      contentType: CONTENT_TYPES[job.format],
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /**
   * Ask for a person to be erased (MVP_SPEC M11, ADR-0032).
   *
   * Recorded and queued, never performed here. The API deliberately does not
   * hold the credentials that can redact an audit diff — that is the whole
   * design — so the most it can do is write down that an erasure was authorized,
   * by whom, and for which subject. The worker opens the narrow window and
   * closes it again.
   */
  async createErasure(
    actor: Actor,
    input: ErasureCreateInput,
  ): Promise<ErasureRequestContract> {
    // `delete` on `data_subject`: the Owner alone, by seed. Irreversible, and
    // it reaches into the append-only audit log.
    assertCan(actor, 'delete', { objectType: 'data_subject' });

    return this.inTenant(actor, async (tx) => {
      await this.assertSubjectReachable(
        tx,
        actor,
        input.subjectObjectType,
        input.subjectRecordId,
      );

      const inserted = await this.repository.insertErasure(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        subjectObjectType: input.subjectObjectType,
        subjectRecordId: input.subjectRecordId,
        status: 'pending',
        reason: input.reason ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      // The partial unique index refused it: this subject is already being
      // erased. 409 rather than returning the in-flight one, because "your
      // request was accepted" would be a lie about a different request.
      if (inserted === null) {
        throw new ConflictError('An erasure for this person is already in progress');
      }

      // The audit entry for an erasure carries **no values**, only which fields
      // were in scope and why. Recording the old values here would defeat the
      // redaction that follows it: the erasure's own audit row would become the
      // last place the erased data still lives.
      await this.audit.record(tx, actor, {
        action: 'erase',
        objectType: 'data_subject',
        recordId: inserted.id,
        changes: {
          reason: { new: input.reason ?? null },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'erasure.requested.v1',
        objectType: 'erasure_request',
        recordId: inserted.id,
        payload: {
          subjectObjectType: input.subjectObjectType,
          subjectRecordId: input.subjectRecordId,
        },
      });

      return serializeErasure(inserted);
    });
  }

  async listErasures(
    actor: Actor,
    query: ErasureListQuery,
  ): Promise<{
    data: ErasureRequestContract[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }> {
    assertCan(actor, 'read', { objectType: 'data_subject' });
    const cursor = resolveCursor(query.cursor);

    return this.inTenant(actor, async (tx) => {
      const rows = await this.repository.listErasures(
        tx,
        actor.tenantId,
        query.limit + 1,
        cursor,
      );
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];

      return {
        data: page.map(serializeErasure),
        meta: {
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({ value: last.cursorValue, id: last.id })
              : null,
          hasMore,
        },
      };
    });
  }

  async getErasure(actor: Actor, id: string): Promise<ErasureRequestContract> {
    assertCan(actor, 'read', { objectType: 'data_subject' });

    return this.inTenant(actor, async (tx) => {
      const found = await this.repository.findErasure(tx, actor.tenantId, id);
      if (found === null) throw new NotFoundError('Erasure request');
      return serializeErasure(found);
    });
  }

  /**
   * The subject must be a record this caller could have read.
   *
   * Holding `data_subject` does not make every record in the workspace
   * addressable: a rep's `own` scope still applies, and a record in another
   * tenant is excluded by RLS before this runs. All three cases answer 404
   * identically, so the endpoint cannot be used to find out which ids exist
   * (CLAUDE.md §5.5).
   *
   * A soft-deleted subject is deliberately still reachable: somebody deleted
   * into the Recycle Bin is exactly who an erasure request tends to be about.
   */
  private async assertSubjectReachable(
    tx: Tx,
    actor: Actor,
    objectType: ErasableObjectType,
    recordId: string,
  ): Promise<void> {
    const decision = can(actor, 'read', { objectType });
    if (!decision.allowed) throw new NotFoundError(objectType);

    const row = await selectSubjectRecord(tx, actor.tenantId, objectType, recordId);
    if (row === null) throw new NotFoundError(objectType);

    const descriptor = descriptorFor(objectType);
    const ownerId = row[camelCase(descriptor.ownerColumn)] ?? row[descriptor.ownerColumn] ?? null;
    assertCan(actor, 'read', {
      objectType,
      record: { ownerId: typeof ownerId === 'string' ? ownerId : null },
    });
  }

  private async loadOwnExport(tx: Tx, actor: Actor, id: string): Promise<DataExportJob> {
    const job = await this.repository.findOwnExport(tx, actor.tenantId, actor.userId, id);
    if (job === null) throw new NotFoundError('Archive');
    return job;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function requireSubject(input: DataExportCreateInput): {
  objectType: ErasableObjectType;
  recordId: string;
} {
  if (input.subject === undefined) {
    throw new ValidationError([
      { path: 'subject', message: "A data-subject archive needs a subject" },
    ]);
  }
  return { objectType: input.subject.objectType, recordId: input.subject.recordId };
}

/** `owner_id` -> `ownerId`, for reading a raw row either way round. */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function serializeExport(job: DataExportJob): DataExportJobContract {
  return {
    id: job.id,
    kind: job.kind,
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

function serializeErasure(request: ErasureRequest): ErasureRequestContract {
  return {
    id: request.id,
    subjectObjectType: request.subjectObjectType,
    subjectRecordId: request.subjectRecordId,
    status: request.status,
    reason: request.reason ?? null,
    recordsErased: request.recordsErased,
    auditRowsRedacted: request.auditRowsRedacted,
    failureReason: request.failureReason ?? null,
    requestedBy: request.createdBy ?? null,
    createdAt: request.createdAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
  };
}

function resolveCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) {
    throw new ValidationError([{ path: 'cursor', message: 'Malformed cursor' }]);
  }
  return cursor;
}

export type { DataExportKind };
