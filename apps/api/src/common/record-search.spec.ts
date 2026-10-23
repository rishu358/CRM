import { describe, expect, it } from 'vitest';
import { LIST_MATCH_LIMIT, newId, type Actor, type RecordMatchRequest } from '@crm/core';
import type { Tx } from '@crm/db';
import type { ApiSearchProvider } from '../platform/search/search.tokens.js';
import { readableSearchFields } from './field-queries.js';
import { searchForList } from './record-search.js';

/**
 * What a list's search box asks of the search seam, and what it does with the answer (ADR-0041 §5).
 * The engine itself is covered by the provider contract; this is the list's side of the bargain, so
 * it uses a provider that only records what it was asked.
 */

const tenantId = newId();
const userId = newId();
const actor: Actor = { userId, tenantId, teamIds: [], permissions: { roles: [] } };
const tx = {} as Tx;
const constraint = { kind: 'own', userId } as const;

function providerAnswering(recordIds: readonly string[], truncated: boolean) {
  const asked: RecordMatchRequest[] = [];
  const provider = {
    matchRecordIds: (_tx: Tx, request: RecordMatchRequest) => {
      asked.push(request);
      return Promise.resolve({ recordIds, truncated });
    },
  } as unknown as ApiSearchProvider;
  return { provider, asked };
}

describe('a list’s search box', () => {
  it('does not search at all when nothing was typed', async () => {
    const { provider, asked } = providerAnswering(['a'], false);
    const result = await searchForList(provider, tx, actor, 'contact', constraint, undefined);
    expect(result).toEqual({ matchedIds: undefined, truncated: false });
    expect(asked).toHaveLength(0);
  });

  it('narrows nothing for a word too short to search, rather than emptying the list', async () => {
    const { provider, asked } = providerAnswering([], false);
    const result = await searchForList(provider, tx, actor, 'contact', constraint, 'a');
    expect(result.matchedIds).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it('asks for this company’s records of this object, within the actor’s scope and readable fields', async () => {
    const { provider, asked } = providerAnswering(['x', 'y'], false);
    const result = await searchForList(provider, tx, actor, 'lead', constraint, 'smith');
    expect(result).toEqual({ matchedIds: ['x', 'y'], truncated: false });
    expect(asked).toEqual([
      {
        tenantId,
        term: 'smith',
        scope: {
          objectType: 'lead',
          constraint,
          fieldKeys: readableSearchFields(actor, 'lead'),
        },
        limit: LIST_MATCH_LIMIT,
      },
    ]);
  });

  it('asks for no more than the list will show: 300', () => {
    expect(LIST_MATCH_LIMIT).toBe(300);
  });

  it('reports that a search matched more than the list shows, instead of pretending it is all', async () => {
    const { provider } = providerAnswering(['x'], true);
    const result = await searchForList(provider, tx, actor, 'account', constraint, 'acme');
    expect(result.truncated).toBe(true);
  });
});
