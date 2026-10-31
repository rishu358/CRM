import { Module } from '@nestjs/common';
import { EmailUnsubscribeController } from './email-unsubscribe.controller.js';
import { EmailUnsubscribeRepository } from './email-unsubscribe.repository.js';
import { EmailUnsubscribeService } from './email-unsubscribe.service.js';

/**
 * The unsubscribe link (ADR-0001, ADR-0076): the public door a person's click reaches, and nothing else. Like
 * the events door it is deliberately separate from the email module, so the code a stranger can reach is a few
 * small files with a test that fails if their imports widen.
 */
@Module({
  controllers: [EmailUnsubscribeController],
  providers: [EmailUnsubscribeService, EmailUnsubscribeRepository],
})
export class EmailUnsubscribeModule {}
