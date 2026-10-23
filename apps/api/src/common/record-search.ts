import {
  LIST_MATCH_LIMIT,
  isUsableSearchTerm,
  type Actor,
  type RecordConstraint,
  type SearchableObjectType,
} from '@crm/core';
import type { Tx } from '@crm/db';
import { readableSearchFields } from './field-queries.js';
import type { ApiSearchProvider } from '../platform/search/search.tokens.js';

/**
 * A list's search box, answered by the search seam (ADR-0041 §5).
 *
 * A list used to run `ILIKE '%term%'` over a few columns of its own table. That scanned every row
 * for a term that matched nothing (3.7 s at a million contacts), could not be indexed under
 * row-level security, and had to be taught field permissions separately. It now asks the
 * `SearchProvider` which records of this object match, as ids, and the list applies its own sort,
 * filters, record scope and paging to them, so it behaves the same whichever engine is behind the
 * seam.
 *
 * What the caller gets is deliberately bounded: at most `LIST_MATCH_LIMIT` records, newest first,
 * and `truncated` says whether there were more. The list reports that to the client rather than
 * pretending the first few hundred are all of them.
 *
 * A query with no word long enough to search for (one character) narrows nothing: it is not "no
 * results", which would empty the list on the first keystroke.
 */
export interface ListSearch {
  /** Restrict the list to these ids. `undefined` means the list is not being searched. */
  readonly matchedIds: readonly string[] | undefined;
  readonly truncated: boolean;
}

const NOT_SEARCHED: ListSearch = { matchedIds: undefined, truncated: false };

export async function searchForList(
  provider: ApiSearchProvider,
  tx: Tx,
  actor: Actor,
  objectType: SearchableObjectType,
  constraint: RecordConstraint,
  term: string | undefined,
): Promise<ListSearch> {
  if (term === undefined || !isUsableSearchTerm(term)) return NOT_SEARCHED;

  const result = await provider.matchRecordIds(tx, {
    tenantId: actor.tenantId,
    term,
    scope: {
      objectType,
      constraint,
      // What the caller may read, and nothing else: matching a field is a read of it (CLAUDE.md §5.4).
      fieldKeys: readableSearchFields(actor, objectType),
    },
    limit: LIST_MATCH_LIMIT,
  });
  return { matchedIds: result.recordIds, truncated: result.truncated };
}
