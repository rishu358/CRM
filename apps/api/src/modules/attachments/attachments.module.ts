import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ActivitiesModule } from '../activities/activities.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { AttachmentTargetsService } from './attachment-targets.service.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsRepository } from './attachments.repository.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * Record attachments (ADR-0001, ADR-0035, MVP_SPEC §6.1).
 *
 * It imports the five modules whose records can carry a file, because a
 * polymorphic target has to be judged by whoever owns it (ADR-0005) — through
 * their **services**, never their repositories or tables. The dependency runs
 * one way: none of the five knows this module exists, so all five can still be
 * split out later.
 *
 * The repository is not exported. Anything that needs attachments asks
 * `AttachmentsService`, or listens for its events.
 */
@Module({
  imports: [AccountsModule, ContactsModule, LeadsModule, DealsModule, ActivitiesModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentsRepository, AttachmentTargetsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
