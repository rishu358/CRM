import { Injectable } from '@nestjs/common';
import {
  attachments,
  type Attachment,
  type AttachmentStatus,
  type NewAttachment,
  type Tx,
  and,
  asc,
  count,
  eq,
  isNull,
  sql,
} from '@crm/db';
import type { AttachmentTargetType } from '@crm/core';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';

/**
 * Data access for attachments.
 *
 * Every query names `tenant_id` even though RLS already confines it: the
 * policy is the control, the predicate is the thing that makes the index work
 * (CLAUDE.md §7 — composite indexes start with `tenant_id`).
 *
 * Nothing here decides anything. Whether the caller may see the record these
 * rows hang from is settled before a method on this class is called, because
 * only the module that owns the record can answer it (ADR-0035).
 */
export interface AttachmentListResult {
  readonly rows: Attachment[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

@Injectable()
export class AttachmentsRepository {
  async insert(tx: Tx, values: NewAttachment): Promise<Attachment> {
    const rows = await tx.insert(attachments).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no attachment');
    return row;
  }

  /** A live attachment in this tenant, whatever its status. */
  async findById(tx: Tx, tenantId: string, id: string): Promise<Attachment | null> {
    const rows = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.id, id),
          isNull(attachments.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** How many files are already on this record, for the per-record ceiling. */
  async countForRecord(
    tx: Tx,
    tenantId: string,
    objectType: AttachmentTargetType,
    recordId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.objectType, objectType),
          eq(attachments.recordId, recordId),
          isNull(attachments.deletedAt),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * The files on one record, oldest first, keyset-paginated (ADR-0012).
   *
   * Only `ready` rows: a row exists from the moment the upload is declared,
   * and one whose bytes have not been checked — or were refused — is not a
   * file anybody should be offered. The uploader learns its fate from the
   * response to `uploaded`, not from this list.
   */
  async listForRecord(
    tx: Tx,
    tenantId: string,
    objectType: AttachmentTargetType,
    recordId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<AttachmentListResult> {
    const predicates = [
      eq(attachments.tenantId, tenantId),
      eq(attachments.objectType, objectType),
      eq(attachments.recordId, recordId),
      eq(attachments.status, 'ready'),
      isNull(attachments.deletedAt),
    ];

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null && cursor.value !== null) {
      predicates.push(
        sql`((${attachments.createdAt}, ${attachments.id}) > (${cursor.value}::timestamptz, ${cursor.id}::uuid))`,
      );
    }

    const rows = await tx
      .select()
      .from(attachments)
      .where(and(...predicates))
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .limit(options.limit + 1);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    // The timestamp is rendered by Postgres, not by JavaScript: a Date holds
    // milliseconds and the column holds microseconds, so a JS-built cursor
    // would re-include the boundary row on the next page (ADR-0012).
    let nextCursor: string | null = null;
    if (hasMore && last !== undefined) {
      const text = await tx.execute(
        sql`select ${attachments.createdAt}::text as value from ${attachments} where ${attachments.id} = ${last.id}`,
      );
      const value = (text.rows[0] as { value: string } | undefined)?.value ?? null;
      nextCursor = encodeCursor({ value, id: last.id });
    }

    return { rows: page, hasMore, nextCursor };
  }

  /**
   * Move an attachment along, only if it is still where the caller thinks it
   * is. The status is in the WHERE clause, so a double-click cannot have both
   * requests win: the second matches zero rows.
   */
  async transition(
    tx: Tx,
    tenantId: string,
    id: string,
    from: AttachmentStatus,
    patch: Partial<NewAttachment>,
  ): Promise<Attachment | null> {
    const rows = await tx
      .update(attachments)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.id, id),
          eq(attachments.status, from),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Soft delete. Returns null when it was already gone. */
  async softDelete(
    tx: Tx,
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<Attachment | null> {
    const now = new Date();
    const rows = await tx
      .update(attachments)
      .set({ deletedAt: now, updatedAt: now, updatedBy: userId })
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.id, id),
          isNull(attachments.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}
