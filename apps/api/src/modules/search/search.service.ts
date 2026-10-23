import { Inject, Injectable } from '@nestjs/common';
import {
  can,
  isUsableSearchTerm,
  readableFieldKeys,
  SEARCHABLE_OBJECT_TYPES,
  searchableFieldKeys,
  type Actor,
  type SearchObjectScope,
} from '@crm/core';
import type { SearchQuery, SearchResult } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { SearchLabelsService } from './search-labels.service.js';
import { SEARCH_PROVIDER, type ApiSearchProvider } from '../../platform/search/search.tokens.js';
import { serializeSearchResults } from './search.serializer.js';

/**
 * Global search (MVP_SPEC §M7, ADR-0028).
 *
 * The one read path that deliberately crosses every object, which makes it the
 * easiest place in the product to leak from. Its whole job is to turn the
 * actor's permissions into a description the engine can apply **while it
 * selects rows**, and then to hand the hits back to the modules that own them.
 *
 * Nothing here filters a result set. The three things that could be filtered —
 * which object types, which records, which fields — are all decided before the
 * query runs:
 *
 *   - an object type the actor cannot read is not in `scopes`, so the engine
 *     never looks at it;
 *   - the record scope for each object type travels as a `RecordConstraint`
 *     and becomes part of the WHERE clause;
 *   - the searchable fields the actor may read travel as a key list, so a
 *     hidden field is neither matched on nor quoted back in a snippet.
 *
 * There is no `assertCan` at the top. Search is a question about the caller's
 * own workspace, not an action on a record: a caller who may read nothing gets
 * an empty list, because a 403 would be the one answer that distinguishes "you
 * have no permissions" from "there is nothing here", and neither is worth
 * telling them.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SEARCH_PROVIDER) private readonly provider: ApiSearchProvider,
    @Inject(SearchLabelsService) private readonly labels: SearchLabelsService,
  ) {}

  async search(actor: Actor, query: SearchQuery): Promise<SearchResult[]> {
    // One character matches a large fraction of a tenant's rows and spends the
    // whole latency budget to do it. The palette waits for the second key.
    if (!isUsableSearchTerm(query.q)) return [];

    const scopes = this.scopesFor(actor);
    if (scopes.length === 0) return [];

    return this.inTenant(actor, async (tx) => {
      const hits = await this.provider.search(tx, {
        tenantId: actor.tenantId,
        term: query.q,
        limit: query.limit,
        scopes,
      });

      if (hits.length === 0) return [];

      const labels = await this.labels.resolve(tx, actor, hits);
      return serializeSearchResults(actor, hits, labels);
    });
  }

  /**
   * What this actor may search, object type by object type.
   *
   * Two independent reasons to leave a type out, and both mean "not in the
   * request" rather than "filtered out later":
   *
   *   - `can()` refuses the read, so there is nothing to search;
   *   - every one of the type's searchable fields is hidden for this role, so
   *     there is nothing left to match on. An empty key list would otherwise
   *     have to be interpreted somewhere downstream, and "empty means
   *     everything" is the kind of default that turns into a breach.
   */
  private scopesFor(actor: Actor): SearchObjectScope[] {
    const scopes: SearchObjectScope[] = [];

    for (const objectType of SEARCHABLE_OBJECT_TYPES) {
      const decision = can(actor, 'read', { objectType });
      if (!decision.allowed) continue;

      const fieldKeys = readableFieldKeys(actor, objectType, searchableFieldKeys(objectType));
      if (fieldKeys.length === 0) continue;

      scopes.push({ objectType, constraint: decision.constraint, fieldKeys });
    }

    return scopes;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
