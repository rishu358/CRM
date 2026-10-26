import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * In-app notifications (ADR-0001, MVP_SPEC M6).
 *
 * Read-only as far as the API is concerned: notifications are written by the
 * worker from outbox events (ADR-0006), and this module lets the person they
 * belong to read them and mark them read.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
