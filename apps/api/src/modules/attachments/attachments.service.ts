import { Inject, Injectable } from '@nestjs/common';
import {
  ATTACHMENT_LIMITS,
  attachmentContentType,
  attachmentFileNameProblem,
  ConflictError,
  newId,
  NotFoundError,
  PRESIGNED_URL_TTL_SECONDS,
  ValidationError,
  type Actor,
  type StorageProvider,
} from '@crm/core';
import type {
  Attachment as AttachmentContract,
  AttachmentCreateInput,
  AttachmentCreateResult,
  AttachmentListQuery,
  DownloadLink,
} from '@crm/contracts';
import type { Attachment, Tx } from '@crm/db';
import { newStorageKey } from '@crm/storage';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { STORAGE_PROVIDER } from '../../platform/storage/storage.tokens.js';
import { AttachmentTargetsService } from './attachment-targets.service.js';
import { AttachmentsRepository } from './attachments.repository.js';
import { serializeAttachment } from './attachments.serializer.js';

/**
 * Record attachments on the request side (MVP_SPEC §6.1, ADR-0035).
 *
 * The API does four things for a file and never a fifth. It records that one
 * is expected, hands the browser a place to put it, records that it arrived,
 * and hands out short-lived links to read it back. **It never reads or writes
 * the bytes** (CLAUDE.md §5.12): the type check happens in the worker, so a
 * hostile upload can only exhaust a process that restarts, never a request
 * handler that serves everyone else. `head` and `delete` are metadata
 * operations on the store and are the only two it calls.
 *
 * Every method begins at the *record*, not at the attachment: the target is
 * resolved through the module that owns it, for the action being attempted,
 * and a record the actor cannot reach is a 404 before an attachment is even
 * looked up. That is what keeps the polymorphic pair from becoming a way
 * around record scope (ADR-0005).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AttachmentsRepository) private readonly repository: AttachmentsRepository,
    @Inject(AttachmentTargetsService) private readonly targets: AttachmentTargetsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Declare a file and get somewhere to put it.
   *
   * The content type is decided **here**, from the allow-listed extension, and
   * bound into the signature along with the exact size. A client-supplied type
   * never reaches the store, and the store will refuse a body of any other
   * length — a presigned PUT cannot express a ceiling, only an exact size, and
   * "exactly what you said you would send" is the stronger rule anyway.
   */
  async create(actor: Actor, input: AttachmentCreateInput): Promise<AttachmentCreateResult> {
    // The contract already refuses these; the service does not rely on that.
    const problem = attachmentFileNameProblem(input.fileName);
    const contentType = attachmentContentType(input.fileName);
    if (problem !== null || contentType === null) {
      throw new ValidationError([
        { path: 'fileName', message: 'That file type cannot be attached' },
      ]);
    }

    const attachment = await this.inTenant(actor, async (tx) => {
      // Attaching a file changes the record, so it needs `update` on it.
      await this.targets.assert(tx, actor, 'update', input.objectType, input.recordId);

      const existing = await this.repository.countForRecord(
        tx,
        actor.tenantId,
        input.objectType,
        input.recordId,
      );
      if (existing >= ATTACHMENT_LIMITS.maxPerRecord) {
        throw new ConflictError(
          `A record may have at most ${ATTACHMENT_LIMITS.maxPerRecord} attachments`,
        );
      }

      const inserted = await this.repository.insert(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        objectType: input.objectType,
        recordId: input.recordId,
        // Random, and never derived from anything the user typed (§5.12).
        fileKey: newStorageKey(actor.tenantId, 'attachments'),
        fileName: input.fileName,
        mime: contentType,
        sizeBytes: input.sizeBytes,
        status: 'awaiting_upload',
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'attachment',
        recordId: inserted.id,
        changes: {
          objectType: { new: inserted.objectType },
          recordId: { new: inserted.recordId },
          fileName: { new: inserted.fileName },
          sizeBytes: { new: inserted.sizeBytes },
        },
      });

      return inserted;
    });

    const signed = await this.storage.createUploadUrl({
      key: attachment.fileKey,
      contentType: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.upload,
    });

    return {
      attachment: serializeAttachment(attachment),
      upload: {
        url: signed.url,
        method: signed.method,
        headers: signed.headers,
        expiresAt: signed.expiresAt.toISOString(),
      },
    };
  }

  /**
   * The browser says the upload finished.
   *
   * The API checks the one thing it can check without reading bytes — that an
   * object of exactly the declared size is there — and hands the rest to the
   * worker. Idempotent, because a user double-clicks and a flaky network
   * retries: an attachment that has already moved on is returned as it is.
   */
  async confirmUploaded(actor: Actor, id: string): Promise<AttachmentContract> {
    const attachment = await this.inTenant(actor, (tx) =>
      this.loadForAction(tx, actor, 'update', id),
    );

    if (attachment.status !== 'awaiting_upload') return serializeAttachment(attachment);

    // Network I/O, so outside the transaction: a slow object store must not
    // hold a database connection.
    const stored = await this.storage.head(attachment.fileKey);
    if (stored === null) {
      throw new ConflictError('The file has not finished uploading');
    }
    if (
      stored.sizeBytes !== attachment.sizeBytes ||
      stored.sizeBytes > ATTACHMENT_LIMITS.maxUploadBytes
    ) {
      return this.reject(
        actor,
        attachment,
        'The uploaded file is not the size that was declared, so it was refused',
      );
    }

    return this.inTenant(actor, async (tx) => {
      const moved = await this.repository.transition(
        tx,
        actor.tenantId,
        attachment.id,
        'awaiting_upload',
        { status: 'scanning', updatedBy: actor.userId },
      );
      if (moved === null) {
        // Another request got there first; whatever it did is the truth now.
        return serializeAttachment(await this.loadForAction(tx, actor, 'update', id));
      }

      // Same transaction as the status change: the event exists if and only if
      // the attachment is waiting to be checked (ADR-0006).
      await this.outbox.publish(tx, actor, {
        eventType: 'attachment.uploaded.v1',
        objectType: 'attachment',
        recordId: attachment.id,
      });
      return serializeAttachment(moved);
    });
  }

  /**
   * One attachment in any state, for the person watching it upload.
   *
   * The list shows only files that passed the byte check, and that check runs
   * in the worker *after* `confirmUploaded` has returned — so a refusal cannot
   * be in that response. This is where the uploader learns it, with the reason
   * (ADR-0035 §4). Gated like every other read: `read` on the record, 404
   * otherwise, so it is no way to learn what hangs from a record you cannot see.
   */
  async getById(actor: Actor, id: string): Promise<AttachmentContract> {
    return this.inTenant(actor, async (tx) =>
      serializeAttachment(await this.loadForAction(tx, actor, 'read', id)),
    );
  }

  async list(
    actor: Actor,
    query: AttachmentListQuery,
  ): Promise<{
    data: AttachmentContract[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }> {
    return this.inTenant(actor, async (tx) => {
      // Reading the files on a record requires reading the record.
      await this.targets.assert(tx, actor, 'read', query.objectType, query.recordId);

      const result = await this.repository.listForRecord(
        tx,
        actor.tenantId,
        query.objectType,
        query.recordId,
        { limit: query.limit, cursor: query.cursor },
      );
      return {
        data: result.rows.map((row) => serializeAttachment(row)),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
      };
    });
  }

  /**
   * A short-lived link to the file. Issuing it is the audited event.
   *
   * The link is the moment the file leaves, so it is recorded as an export —
   * the same action an export job's download link uses, so "what left this
   * tenant, and when" is one query rather than two.
   */
  async downloadLink(actor: Actor, id: string): Promise<DownloadLink> {
    const attachment = await this.inTenant(actor, async (tx) => {
      const found = await this.loadForAction(tx, actor, 'read', id);
      if (found.status !== 'ready') {
        throw new ConflictError('This file is not available');
      }

      await this.audit.record(tx, actor, {
        action: 'export',
        objectType: 'attachment',
        recordId: found.id,
        changes: { file: { new: 'download link issued' } },
      });
      return found;
    });

    const link = await this.storage.createDownloadUrl({
      key: attachment.fileKey,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS.download,
      fileName: attachment.fileName,
      // Our own canonical type for the extension, never the client's and never
      // a sniffed one echoed back. The store serves it as an attachment.
      contentType: attachment.mime,
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /**
   * Remove a file from a record.
   *
   * A soft delete, and the stored object stays: an undelete that cannot bring
   * the file back is not an undelete. The worker removes both once the
   * retention window passes, driven by an event dated to that moment
   * (ADR-0025's scheduler, ADR-0035's reason for using it).
   */
  async remove(actor: Actor, id: string): Promise<void> {
    await this.inTenant(actor, async (tx) => {
      // Removing a file changes the record, so it needs `update` on it.
      const attachment = await this.loadForAction(tx, actor, 'update', id);

      const deleted = await this.repository.softDelete(tx, actor.tenantId, id, actor.userId);
      if (deleted === null) throw new NotFoundError('Attachment');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'attachment',
        recordId: id,
        changes: {
          objectType: { old: attachment.objectType },
          recordId: { old: attachment.recordId },
          fileName: { old: attachment.fileName },
        },
      });
      await this.outbox.publish(
        tx,
        actor,
        { eventType: 'attachment.purge_due.v1', objectType: 'attachment', recordId: id },
        { availableAt: purgeDueAt() },
      );
    });
  }

  /**
   * Load an attachment the actor may act on, or raise 404.
   *
   * Two gates, in this order: the row must exist in this tenant (RLS and the
   * tenant predicate), and the actor must be allowed to take `action` on the
   * record it hangs from. Doing it in this order means an attachment id from
   * another tenant and one from a record outside the caller's scope produce
   * exactly the same 404 — which is the point (CLAUDE.md §5.5).
   */
  private async loadForAction(
    tx: Tx,
    actor: Actor,
    action: 'read' | 'update',
    id: string,
  ): Promise<Attachment> {
    const attachment = await this.repository.findById(tx, actor.tenantId, id);
    if (attachment === null) throw new NotFoundError('Attachment');

    if (
      !(await this.targets.allows(tx, actor, action, attachment.objectType, attachment.recordId))
    ) {
      throw new NotFoundError('Attachment');
    }
    return attachment;
  }

  /** Refuse a file and take it out of the store; there is no reason to keep it. */
  private async reject(
    actor: Actor,
    attachment: Attachment,
    reason: string,
  ): Promise<AttachmentContract> {
    const rejected = await this.inTenant(actor, (tx) =>
      this.repository.transition(tx, actor.tenantId, attachment.id, 'awaiting_upload', {
        status: 'rejected',
        failureReason: reason,
        updatedBy: actor.userId,
      }),
    );
    await this.storage.delete(attachment.fileKey);
    return serializeAttachment(rejected ?? attachment);
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

/** When a deleted attachment's bytes may be removed (ADR-0035). */
function purgeDueAt(): Date {
  return new Date(Date.now() + ATTACHMENT_LIMITS.purgeAfterDays * 24 * 60 * 60 * 1000);
}
