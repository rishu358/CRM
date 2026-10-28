import { Module } from '@nestjs/common';
import { AccessController } from './access.controller.js';
import { AccessRepository } from './access.repository.js';
import { AccessSupport } from './access.support.js';
import { ExplainerService } from './explainer.service.js';
import { LeadOwnerDirectory } from './lead-owner-directory.service.js';
import { MemberDirectory } from './member-directory.service.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { OwnershipController } from './ownership.controller.js';
import { OwnershipService } from './ownership.service.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';

/**
 * Users, roles, teams, ownership and the access explainer (MVP_SPEC M3).
 *
 * One module because they are one bounded context — the permission
 * configuration and what it means — and because the explainer and the effect
 * preview must read the same repository the editors write through. The
 * repository is **not** exported, like every other module's.
 *
 * What this module does *not* do is touch another module's tables. Record
 * counts and owners come from the read-only catalogue in `@crm/db`, and a
 * reassignment writes through the one statement each owning module has
 * registered a table for (`OwnershipRegistry`).
 */
@Module({
  controllers: [
    AccessController,
    RolesController,
    MembersController,
    TeamsController,
    OwnershipController,
  ],
  providers: [
    AccessRepository,
    AccessSupport,
    RolesService,
    MembersService,
    TeamsService,
    OwnershipService,
    ExplainerService,
    MemberDirectory,
    LeadOwnerDirectory,
  ],
  exports: [MemberDirectory, LeadOwnerDirectory, OwnershipService],
})
export class AccessModule {}
