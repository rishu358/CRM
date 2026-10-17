import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  notificationListQuerySchema,
  notificationParamsSchema,
  type NotificationListQuery,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';

/**
 * `/api/v1/notifications` (ADR-0007, MVP_SPEC M6).
 *
 * No endpoint here takes a user id. The signed-in person is the only person
 * these routes can be about, which is a stronger guarantee than checking an
 * id against the session would be — there is nothing to check.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(notificationListQuerySchema)) query: NotificationListQuery,
  ) {
    return this.notifications.list(actor, query);
  }

  /** The bell's badge. Its own route so polling it costs one indexed count. */
  @Get('unread-count')
  async unreadCount(@CurrentActor() actor: Actor) {
    return { data: { unread: await this.notifications.unreadCount(actor) } };
  }

  @Post('read-all')
  async markAllRead(@CurrentActor() actor: Actor) {
    return { data: await this.notifications.markAllRead(actor) };
  }

  @Post(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(notificationParamsSchema)) params: { id: string },
  ): Promise<void> {
    await this.notifications.markRead(actor, params.id);
  }
}
