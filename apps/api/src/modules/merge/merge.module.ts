import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { MergeController } from './merge.controller.js';
import { MergeService } from './merge.service.js';

/**
 * Record merge (ADR-0001, ADR-0064).
 *
 * Owns no record and no table: every change to a contact or an account goes through that module's own
 * service, and the rows that point at them are moved by the statements in `@crm/db`. It imports the two
 * modules and neither knows it exists.
 */
@Module({
  imports: [ContactsModule, AccountsModule],
  controllers: [MergeController],
  providers: [MergeService],
})
export class MergeModule {}
