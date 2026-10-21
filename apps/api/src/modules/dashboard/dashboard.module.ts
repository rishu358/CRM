import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ActivitiesModule } from '../activities/activities.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The home dashboard (MVP_SPEC M10, ADR-0038).
 *
 * No repository, because no table: it reaches deals, leads, activities and
 * people through the services those modules chose to export, which is the whole
 * of what ADR-0001 asks of a module that wants another's data.
 */
@Module({
  imports: [AccessModule, ActivitiesModule, DealsModule, LeadsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
