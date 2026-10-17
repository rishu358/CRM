import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';

/**
 * The invitations module (ADR-0001).
 *
 * The repository is **not** exported, like every other module's. What this one
 * does import is `AuthService` — never `AuthRepository` — because the identity
 * tables belong to the auth module and reaching into them directly is the
 * boundary violation that makes the monolith impossible to split later
 * (CLAUDE.md §3). `AuthModule` is global, so there is nothing to import here.
 */
@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationsRepository],
  exports: [InvitationsService],
})
export class InvitationsModule {}
