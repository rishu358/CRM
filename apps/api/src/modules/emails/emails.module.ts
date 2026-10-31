import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailSettingsController, EmailsController } from './emails.controller.js';
import { EmailsRepository } from './emails.repository.js';
import { EmailsService } from './emails.service.js';

/**
 * Email sent from a record, and the log of it (ADR-0001, ADR-0073).
 *
 * Owns `email_messages`, `email_message_links`, `email_sender_config` and `email_daily_counts`. It
 * reaches contacts, leads and deals only through their services, as the caller, so record scope and
 * field permissions are theirs. It never sends: the worker does, from the outbox.
 */
@Module({
  imports: [ContactsModule, LeadsModule, DealsModule],
  controllers: [EmailsController, EmailSettingsController],
  providers: [EmailsService, EmailSettingsService, EmailsRepository],
  exports: [EmailsService],
})
export class EmailsModule {}
