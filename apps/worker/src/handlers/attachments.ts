import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_PREFIX_LENGTH,
  attachmentFormatMismatch,
  detectAttachmentFormat,
  isAttachmentTargetType,
  type StorageProvider,
} from '@crm/core';
import { attachments, and, eq, isNull, not, sql, type Tx } from '@crm/db';
import type { Logger } from 'pino';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * The three things that happen to an attachment away from a request
 * (ADR-0035).
 *
 *   attachment.uploaded.v1    verify    read the first 8 KB, decide the type
 *                                       from the bytes, compare it with what
 *                                       the name claimed        -> ready
 *   attachment.purge_due.v1   purge     the retention window has passed on a
 *                                       deleted attachment: remove the object
 *                                       and the row
 *   <object>.deleted.v1       prune     the record a file hangs from has
 *                                       really gone; so should the file
 *
 * The first is here rather than in the API because **a file never passes
 * through the API process** (CLAUDE.md §5.12, ADR-0030 §1). The API signs
 * URLs and reads metadata; the worker is the only thing that reads bytes, so
 * a hostile upload can only exhaust a process that restarts.
 *
 * All three are idempotent, because the relay delivers at-least-once: each
 * one's write is conditional on the state it expects to find, so a redelivery
 * matches nothing and does nothing.
 */

export interface AttachmentDeps {
  readonly storage: StorageProvider;
  readonly logger: Logger;
}

/**
 * `object_type` to the table that holds it.
 *
 * A lookup rather than string interpolation of the event's value: the event
 * came from our own outbox, but a table name assembled from a column is one
 * refactor away from being a table name assembled from user input
 * (CLAUDE.md §5.7).
 */
const TABLE_FOR_OBJECT: Readonly<Record<string, string>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

/**
 * Decide what the uploaded bytes actually are.
 *
 * Only the first 8 KB are read, and the object is never held in memory beyond
 * that: the type lives at the front of a file, so there is no reason to read
 * the rest and every reason not to. A file whose bytes disagree with its name
 * is **rejected and deleted** — the mismatch is itself the signal, and a file
 * we refused should not sit in the store costing money.
 *
 * `head` is checked again here, after the API already checked it: the
 * presigned URL outlives the confirmation, so an object can be swapped between
 * the two (ADR-0029 §7 makes the same point about imports). The bytes we judge
 * are the bytes that are there now.
 */
export function verifyAttachment(deps: AttachmentDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const row = await claim(tx, event, 'scanning');
    if (row === null) return;

    const stored = await deps.storage.head(row.fileKey);
    if (stored === null) {
      await reject(tx, deps, row, 'The file could not be found in storage');
      return;
    }
    if (stored.sizeBytes !== row.sizeBytes || stored.sizeBytes > ATTACHMENT_LIMITS.maxUploadBytes) {
      await reject(tx, deps, row, 'The uploaded file is not the size that was declared');
      return;
    }

    const prefix = await deps.storage.readPrefix(row.fileKey, ATTACHMENT_PREFIX_LENGTH);
    const detected = detectAttachmentFormat(prefix);
    if (!detected.ok) {
      await reject(tx, deps, row, detected.reason);
      return;
    }

    const mismatch = attachmentFormatMismatch(row.fileName, detected.format);
    if (mismatch !== null) {
      await reject(tx, deps, row, mismatch);
      return;
    }

    await tx
      .update(attachments)
      .set({
        status: 'ready',
        detectedFormat: detected.format,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(attachments.tenantId, row.tenantId), eq(attachments.id, row.id)));
  };
}

/**
 * Remove a deleted attachment's bytes, and then its row.
 *
 * Scheduled by the delete itself, as an outbox event dated to the end of the
 * retention window (ADR-0025 made the outbox a scheduler; this is a second
 * user of it). No cron, no cross-tenant sweep, and it survives a restart
 * because it is a committed row rather than a timer in a process's memory.
 *
 * **An attachment that was restored is left alone.** The row is only purged
 * while it is still deleted, so an undelete simply makes the pending event a
 * no-op when it fires.
 */
export function purgeAttachment(deps: AttachmentDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;

    const rows = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, event.tenant_id),
          eq(attachments.id, event.record_id),
          not(isNull(attachments.deletedAt)),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return;

    // Bytes first, then the row. In the other order a crash in between would
    // leave an object nothing points at: unreachable, unbilled to anyone, and
    // paid for forever. This order can only ever leave a row whose bytes are
    // gone, which the next delivery tidies up.
    await deps.storage.delete(row.fileKey);
    await tx
      .delete(attachments)
      .where(and(eq(attachments.tenantId, row.tenantId), eq(attachments.id, row.id)));
  };
}

/**
 * Clear the files of a record that has really gone (ADR-0005).
 *
 * ADR-0005 bought cheap new object types by giving up the database foreign key
 * on the `(object_type, record_id)` side, and said plainly that the price is
 * orphan cleanup becoming a worker's job driven by delete events. For
 * attachments the price is higher than for a link row, because an orphan here
 * is not merely untidy: it is a private file nobody can reach and everybody
 * pays to store. So this removes the **object as well as the row**.
 *
 * The existence check is the whole subtlety, and it is the same one
 * `pruneActivityLinks` makes: a delete in this product is a *soft* delete, and
 * the files on a contact in the Recycle Bin must survive that contact being
 * restored. So the handler looks for the row and does nothing while it is
 * still there — which also means it does the right thing the day a hard delete
 * arrives (a Recycle Bin purge, a DPDP erasure request: MVP_SPEC M11) without
 * being changed. Today that means this handler almost always does nothing,
 * and that is correct rather than disappointing.
 */
export function pruneAttachments(deps: AttachmentDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    const objectType = event.object_type;
    const recordId = event.record_id;
    if (objectType === null || recordId === null || !isAttachmentTargetType(objectType)) return;

    const table = TABLE_FOR_OBJECT[objectType];
    if (table === undefined) return;

    const existing = await tx.execute(
      sql`select 1 as present from ${sql.identifier(table)} where id = ${recordId} limit 1`,
    );
    // Soft-deleted but still there: the record can come back from the Recycle
    // Bin, and its files should still be attached when it does.
    if (existing.rows.length > 0) return;

    const orphans = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, event.tenant_id),
          eq(attachments.objectType, objectType),
          eq(attachments.recordId, recordId),
        ),
      );

    for (const orphan of orphans) {
      await deps.storage.delete(orphan.fileKey);
    }

    await tx
      .delete(attachments)
      .where(
        and(
          eq(attachments.tenantId, event.tenant_id),
          eq(attachments.objectType, objectType),
          eq(attachments.recordId, recordId),
        ),
      );
  };
}

/**
 * Take an attachment out of `scanning`, or find it has already been taken.
 *
 * The status is in the WHERE clause, so a redelivered event finds nothing to
 * claim and the handler returns without touching the store.
 */
async function claim(
  tx: Tx,
  event: OutboxRow,
  from: 'scanning',
): Promise<typeof attachments.$inferSelect | null> {
  if (event.record_id === null) return null;

  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.tenantId, event.tenant_id),
        eq(attachments.id, event.record_id),
        eq(attachments.status, from),
        isNull(attachments.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Refuse a file: say why, and take the bytes out of the store.
 *
 * The reason is a sentence for the person who uploaded it — never a stack
 * trace, and never anything read out of the file itself, which is content an
 * attacker chose.
 */
async function reject(
  tx: Tx,
  deps: AttachmentDeps,
  row: typeof attachments.$inferSelect,
  reason: string,
): Promise<void> {
  await tx
    .update(attachments)
    .set({ status: 'rejected', failureReason: reason, updatedAt: new Date() })
    .where(and(eq(attachments.tenantId, row.tenantId), eq(attachments.id, row.id)));

  await deps.storage.delete(row.fileKey);
  deps.logger.info(
    { attachmentId: row.id, tenantId: row.tenantId },
    'Attachment refused after byte check',
  );
}
