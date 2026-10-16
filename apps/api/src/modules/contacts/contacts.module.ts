import { Module } from '@nestjs/common';
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
  controllers: [ContactsController],
  providers: [ContactsService, ContactsRepository],
  exports: [ContactsService],
})
export class ContactsModule {}
