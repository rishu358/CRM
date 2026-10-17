import { Injectable } from '@nestjs/common';
import { notifications, type Notification, type Tx, and, desc, eq, isNull, sql } from '@crm/db';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';

/**
 * Data access for in-app notifications (MVP_SPEC M6).
 *
 * Every method takes `userId` and puts it in the WHERE clause. That is the
 * whole access-control story for this table, which is why it is a parameter
 * on every signature rather than something a caller may forget: a
 * notification is addressed to one person, and RLS only narrows it to one
 * tenant.
 */
@Injectable()
export class NotificationsRepository {
  async list(
    tx: Tx,
    tenantId: string,
    userId: string,
    options: { limit: number; cursor?: string | undefined; unreadOnly: boolean },
  ): Promise<{ rows: Notification[]; nextCursor: string | null; hasMore: boolean }> {
    const predicates = [eq(notifications.tenantId, tenantId), eq(notifications.userId, userId)];
    if (options.unreadOnly) predicates.push(isNull(notifications.readAt));

    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (cursor !== null) {
      // Newest first, so the next page is strictly *older* than the cursor.
      predicates.push(
        sql`(${notifications.createdAt}::text, ${notifications.id}::text) < (${cursor.value}, ${cursor.id})`,
      );
    }

    const rows = await tx
      .select()
      .from(notifications)
      .where(and(...predicates))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(options.limit + 1);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    return {
      rows: page,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ value: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async unreadCount(tx: Tx, tenantId: string, userId: string): Promise<number> {
    const result = await tx.execute(sql`
      select count(*)::int as count
      from notifications
      where tenant_id = ${tenantId} and user_id = ${userId} and read_at is null
    `);
    const row = (result.rows as unknown as { count: number }[])[0];
    return row?.count ?? 0;
  }

  /**
   * Mark one as read, for this user only.
   *
   * The user id is in the WHERE clause rather than checked after a read:
   * there is then no window in which a missing check would let somebody mark
   * another person's notification, and the zero-row result is what the
   * service turns into a 404.
   */
  async markRead(tx: Tx, tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date(), updatedBy: userId })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.id, id),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });

    if (rows.length > 0) return true;

    // Already read is not an error — the bell is clicked twice all the time —
    // so distinguish "yours, already read" from "not yours" with a read that
    // is scoped the same way.
    const existing = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.id, id),
        ),
      )
      .limit(1);
    return existing.length > 0;
  }

  async markAllRead(tx: Tx, tenantId: string, userId: string): Promise<number> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date(), updatedBy: userId })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  }
}
