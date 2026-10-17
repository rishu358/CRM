import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller.js';
import { AccountsRepository } from './accounts.repository.js';
import { AccountsService } from './accounts.service.js';

/**
 * The accounts module (ADR-0001).
 *
 * The repository is **not** exported. Contacts, and later deals and leads,
 * hold an `account_id`; they reach accounts through `AccountsService` or
 * through domain events, never through its repository or its tables. That
 * boundary is what makes the monolith splittable later.
 */
@Module({
  controllers: [AccountsController],
  providers: [AccountsService, AccountsRepository],
  exports: [AccountsService],
})
export class AccountsModule {}
