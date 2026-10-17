import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsController } from './leads.controller.js';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';

/**
 * The leads module (ADR-0001).
 *
 * Conversion reaches contacts, accounts and deals through their **services**,
 * which is why those modules are imported here: it never touches their
 * repositories or tables. The repository is not exported — no other module
 * touches leads through anything but `LeadsService` or a domain event.
 */
@Module({
  imports: [AccountsModule, ContactsModule, DealsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsRepository],
  exports: [LeadsService],
})
export class LeadsModule {}
