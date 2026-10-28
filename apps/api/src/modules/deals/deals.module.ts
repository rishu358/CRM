import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module.js';
import { OwnershipRegistry } from '../../platform/ownership.registry.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { PipelinesModule } from '../pipelines/pipelines.module.js';
import { DealsReportsService } from './deals-reports.service.js';
import { DealsController } from './deals.controller.js';
import { DealsRepository } from './deals.repository.js';
import { DealsService } from './deals.service.js';

/**
 * The deals module (ADR-0001).
 *
 * It reaches accounts, contacts and pipelines through their **services**, which
 * is why those modules are imported here. The repository is not exported: no
 * other module touches deals through anything but `DealsService` or a domain
 * event.
 */
@Module({
  imports: [TagsModule, AccountsModule, ContactsModule, PipelinesModule],
  controllers: [DealsController],
  providers: [DealsService, DealsRepository, DealsReportsService],
  exports: [DealsService, DealsReportsService],
})
export class DealsModule implements OnModuleInit {
  constructor(@Inject(OwnershipRegistry) private readonly ownership: OwnershipRegistry) {}

  /**
   * Tell the platform where this module's records keep their owner, so an
   * administrator can reassign them (MVP_SPEC M3). The names are this module's
   * own constants; the access module never learns another module's schema.
   */
  onModuleInit(): void {
    this.ownership.register({
      objectType: 'deal',
      table: { table: 'deals', ownerColumn: 'owner_id' },
    });
  }
}
