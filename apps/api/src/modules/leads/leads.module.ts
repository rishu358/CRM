import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module.js';
import { OwnershipRegistry } from '../../platform/ownership.registry.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsReportsService } from './leads-reports.service.js';
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
  imports: [TagsModule, AccountsModule, ContactsModule, DealsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsRepository, LeadsReportsService],
  exports: [LeadsService, LeadsReportsService],
})
export class LeadsModule implements OnModuleInit {
  constructor(@Inject(OwnershipRegistry) private readonly ownership: OwnershipRegistry) {}

  /**
   * Tell the platform where this module's records keep their owner, so an
   * administrator can reassign them (MVP_SPEC M3). The names are this module's
   * own constants; the access module never learns another module's schema.
   */
  onModuleInit(): void {
    this.ownership.register({
      objectType: 'lead',
      table: { table: 'leads', ownerColumn: 'owner_id' },
    });
  }
}
