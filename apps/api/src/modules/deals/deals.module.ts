import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { PipelinesModule } from '../pipelines/pipelines.module.js';
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
  imports: [AccountsModule, ContactsModule, PipelinesModule],
  controllers: [DealsController],
  providers: [DealsService, DealsRepository],
  exports: [DealsService],
})
export class DealsModule {}
