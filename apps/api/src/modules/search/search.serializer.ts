import { canReadField, type Actor, type SearchHit } from '@crm/core';
import type { SearchResult } from '@crm/contracts';
import { labelKey } from './search-labels.service.js';

/**
 * The last thing between the index and the response body (CLAUDE.md §5.4).
 *
 * Search is the widest read path in the product — one request, five object
 * types — so each of the three values a result carries is checked here again,
 * even though the provider already applied the same rules in SQL:
 *
 *   - **the record**: dropped unless the owning module resolved it just now,
 *     which covers the window between a reassignment or a delete and the
 *     relay catching up (ADR-0028 §5);
 *   - **the matched field**: dropped unless the actor may read it. The
 *     provider was only given readable keys, so this cannot fire — which is
 *     the point. It is a second lock on the door that matters most, and it is
 *     the assertion that fails first if somebody later widens the key list;
 *   - **the snippet**: the matched field's own indexed value, never the text
 *     around it. A headline built from the whole record would put a hidden
 *     field's contents into the excerpt while the field itself was dutifully
 *     stripped from the payload, which is the classic way a search feature
 *     leaks.
 */
export function serializeSearchResults(
  actor: Actor,
  hits: readonly SearchHit[],
  labels: ReadonlyMap<string, string>,
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const hit of hits) {
    const title = labels.get(labelKey(hit.objectType, hit.recordId));
    if (title === undefined) continue;
    if (!canReadField(actor, hit.objectType, hit.matchedFieldKey)) continue;

    results.push({
      objectType: hit.objectType,
      id: hit.recordId,
      title,
      matchedField: hit.matchedFieldKey,
      snippet: hit.matchedValue,
    });
  }

  return results;
}
