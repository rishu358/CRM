import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ActivitiesController } from './activities.controller.js';
import { ActivitiesRepository } from './activities.repository.js';
import { ActivitiesService } from './activities.service.js';
import { MyDayController } from './my-day.controller.js';
import { MyDayService } from './my-day.service.js';
import { RecordLinksService } from './record-links.service.js';
import { RecordViewsRepository } from './record-views.repository.js';

/**
 * Activities, My Day and recently-viewed (ADR-0001, MVP_SPEC M6).
 *
 * It imports the four record modules because a polymorphic link has to be
 * resolved by whoever owns the record (ADR-0005) — through their **services**,
 * never their repositories or tables. The dependency runs one way: nothing in
 * accounts, contacts, leads or deals knows this module exists, so the four of
 * them can still be split out later.
 *
 * The repositories are not exported. Anything that needs activities asks
 * `ActivitiesService`, or listens for its events.
 */
@Module({
  imports: [AccountsModule, ContactsModule, LeadsModule, DealsModule],
  controllers: [ActivitiesController, MyDayController],
  providers: [
    ActivitiesService,
    ActivitiesRepository,
    RecordLinksService,
    RecordViewsRepository,
    MyDayService,
  ],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
