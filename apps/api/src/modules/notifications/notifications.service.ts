import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, type Actor } from '@crm/core';
import type { Notification, NotificationListQuery } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { NotificationsRepository } from './notifications.repository.js';

/**
 * In-app notifications (MVP_SPEC M6).
 *
 * There is no `can()` call in this file, and that is deliberate rather than
 * an omission. `can()` answers "may this role reach this kind of record, and
 * whose" — a question about data that belongs to the business. A
 * notification belongs to **a person**: it is addressed to them, it says
 * nothing a role could grant somebody else, and there is no scope under
 * which a colleague should read it. The rule is therefore
 * `user_id = <session user>`, applied in SQL on every query, which is both
 * stricter than any grant and impossible to widen by misconfiguring a role.
 *
 * The same reasoning is why nothing here writes a notification. They are
 * written by the worker from outbox events (ADR-0006), so a service cannot
 * notify somebody inline and lose it on a rollback.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NotificationsRepository) private readonly repository: NotificationsRepository,
  ) {}

  async list(
    actor: Actor,
    query: NotificationListQuery,
  ): Promise<{
    data: Notification[];
    meta: { nextCursor: string | null; hasMore: boolean; unread: number };
  }> {
    return this.inTenant(actor, async (tx) => {
      const result = await this.repository.list(tx, actor.tenantId, actor.userId, {
        limit: query.limit,
        cursor: query.cursor,
        unreadOnly: query.unreadOnly ?? false,
      });
      const unread = await this.repository.unreadCount(tx, actor.tenantId, actor.userId);

      return {
        data: result.rows.map((row) => ({
          id: row.id,
          type: row.type,
          payload: row.payload,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        meta: { nextCursor: result.nextCursor, hasMore: result.hasMore, unread },
      };
    });
  }

  async unreadCount(actor: Actor): Promise<number> {
    return this.inTenant(actor, (tx) =>
      this.repository.unreadCount(tx, actor.tenantId, actor.userId),
    );
  }

  /**
   * Mark one as read.
   *
   * Somebody else's notification — or one in another tenant — is a 404, the
   * same answer as an id that does not exist, so this cannot be used to find
   * out whether a given notification is real (CLAUDE.md §5.5).
   */
  async markRead(actor: Actor, id: string): Promise<void> {
    await this.inTenant(actor, async (tx) => {
      const found = await this.repository.markRead(tx, actor.tenantId, actor.userId, id);
      if (!found) throw new NotFoundError('Notification');
    });
  }

  async markAllRead(actor: Actor): Promise<{ updated: number }> {
    return this.inTenant(actor, async (tx) => ({
      updated: await this.repository.markAllRead(tx, actor.tenantId, actor.userId),
    }));
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
