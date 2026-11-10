import { Module } from '@nestjs/common';
import { EmailEventsController } from './email-events.controller.js';
import { EmailEventsRepository } from './email-events.repository.js';
import { EmailEventsService } from './email-events.service.js';

/**
 * The mail service's reports (ADR-0001, ADR-0075): the public door that receives them, and nothing else.
 * It is deliberately separate from the email module, so that the code a stranger can reach is a few small
 * files with a test that fails if their imports widen.
 */
@Module({
  controllers: [EmailEventsController],
  providers: [EmailEventsService, EmailEventsRepository],
})
export class EmailEventsModule {}
