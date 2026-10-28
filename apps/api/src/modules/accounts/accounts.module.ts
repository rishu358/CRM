import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module.js';
import { OwnershipRegistry } from '../../platform/ownership.registry.js';
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
  imports: [TagsModule],
  controllers: [AccountsController],
  providers: [AccountsService, AccountsRepository],
  exports: [AccountsService],
})
export class AccountsModule implements OnModuleInit {
  constructor(@Inject(OwnershipRegistry) private readonly ownership: OwnershipRegistry) {}

  /**
   * Tell the platform where this module's records keep their owner, so an
   * administrator can reassign them (MVP_SPEC M3). The names are this module's
   * own constants; the access module never learns another module's schema.
   */
  onModuleInit(): void {
    this.ownership.register({
      objectType: 'account',
      table: { table: 'accounts', ownerColumn: 'owner_id' },
    });
  }
}
