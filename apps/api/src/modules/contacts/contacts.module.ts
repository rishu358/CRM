import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module.js';
import { OwnershipRegistry } from '../../platform/ownership.registry.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsRepository } from './contacts.repository.js';
import { ContactsService } from './contacts.service.js';

/**
 * The contacts module (ADR-0001).
 *
 * The repository is **not** exported. Other modules reach contacts through
 * `ContactsService` or through domain events — never through its repository or
 * its tables. That boundary is what makes the monolith splittable later.
 */
@Module({
  imports: [TagsModule],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsRepository],
  exports: [ContactsService],
})
export class ContactsModule implements OnModuleInit {
  constructor(@Inject(OwnershipRegistry) private readonly ownership: OwnershipRegistry) {}

  /**
   * Tell the platform where this module's records keep their owner, so an
   * administrator can reassign them (MVP_SPEC M3). The names are this module's
   * own constants; the access module never learns another module's schema.
   */
  onModuleInit(): void {
    this.ownership.register({
      objectType: 'contact',
      table: { table: 'contacts', ownerColumn: 'owner_id' },
    });
  }
}
