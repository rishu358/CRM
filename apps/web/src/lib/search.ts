'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for global search (MVP_SPEC M7, ADR-0028).
 *
 * One endpoint, one hook. The palette asks for a string and gets back records
 * it may open; which objects those come from, and which of them the signed-in
 * user is allowed to see, is decided entirely by the API. Nothing here filters
 * anything, and nothing here knows the names of the five tables involved —
 * the UI must never be the place a visibility rule lives (CLAUDE.md §9).
 */
export type SearchObjectType = 'account' | 'contact' | 'lead' | 'deal' | 'activity';

export interface SearchResultRecord {
  readonly objectType: SearchObjectType;
  readonly id: string;
  readonly title: string;
  /** Which field matched. Always one the signed-in user may read. */
  readonly matchedField: string;
  /** That field's value — never the text around it (ADR-0028 §5). */
  readonly snippet: string;
}

export const searchKeys = {
  all: ['search'] as const,
  forTerm: (term: string) => ['search', term] as const,
};

/**
 * The shortest query worth sending.
 *
 * Mirrors `MIN_SEARCH_TERM_LENGTH` in `@crm/core`, which is what the API
 * enforces. Checking it here too means a single keystroke costs no request at
 * all rather than a round trip that returns an empty list.
 */
export const MIN_SEARCH_LENGTH = 2;

export function useSearch(term: string) {
  const trimmed = term.trim();
  const enabled = trimmed.length >= MIN_SEARCH_LENGTH;

  return useQuery<ItemEnvelope<SearchResultRecord[]>, ApiRequestError>({
    queryKey: searchKeys.forTerm(trimmed),
    queryFn: () =>
      api.get<ItemEnvelope<SearchResultRecord[]>>(
        `/search?q=${encodeURIComponent(trimmed)}&limit=10`,
      ),
    enabled,
    // Keep the previous list on screen while the next one loads, so the
    // palette does not flicker between empty and full on every keystroke.
    placeholderData: keepPreviousData,
    // Results are a snapshot of an index the worker keeps a moment behind
    // anyway; re-fetching the same term inside a few seconds buys nothing.
    staleTime: 5_000,
  });
}

/**
 * Wait for a pause in typing before using a value.
 *
 * A request per keystroke would be both slow and rude to the per-user rate
 * limit (CLAUDE.md §5.14). 150 ms is below the point where typing feels
 * delayed and above the point where a fast typist generates a request per
 * letter.
 */
export function useDebounced<T>(value: T, delayMs = 150): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
