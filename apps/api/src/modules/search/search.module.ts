import { Module } from '@nestjs/common';
import { PostgresSearchProvider } from '@crm/db';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ActivitiesModule } from '../activities/activities.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { DealsModule } from '../deals/deals.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { SearchController } from './search.controller.js';
import { SearchLabelsService } from './search-labels.service.js';
import { SEARCH_PROVIDER } from './search.provider.js';
import { SearchService } from './search.service.js';

/**
 * Global search and the command palette's backend (MVP_SPEC §M7, ADR-0028).
 *
 * It imports the five record modules because a hit has to be resolved by
 * whoever owns the record — through their **services**, never their
 * repositories or tables (ADR-0001). The dependency runs one way: nothing in
 * accounts, contacts, leads, deals or activities knows this module exists, so
 * none of them is harder to split out because search was built.
 *
 * `SEARCH_PROVIDER` is the one line that changes when Postgres full-text is
 * outgrown (CLAUDE.md §2, ADR-0009). Nothing above it names a tsquery, an
 * index or a table.
 */
@Module({
  imports: [AccountsModule, ContactsModule, LeadsModule, DealsModule, ActivitiesModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    SearchLabelsService,
    { provide: SEARCH_PROVIDER, useClass: PostgresSearchProvider },
  ],
  exports: [SearchService],
})
export class SearchModule {}
