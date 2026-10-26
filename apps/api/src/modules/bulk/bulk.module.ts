import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { BulkController } from './bulk.controller.js';
import { BulkService } from './bulk.service.js';

/**
 * Bulk actions on the four record lists, and the workspace's tags (ADR-0001, ADR-0056).
 *
 * This module owns the *orchestration*: the batch, its transaction, the report and the retry
 * memory. It owns no record: every change goes through the owning module's service, which is why
 * it imports them and why none of them knows it exists. The retry memory is the platform's
 * `IdempotencyService`, shared with every create route (ADR-0060).
 */
@Module({
  imports: [AccessModule, ContactsModule, AccountsModule, LeadsModule, DealsModule],
  controllers: [BulkController],
  providers: [BulkService],
})
export class BulkModule {}
