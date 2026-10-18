import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '@crm/core';
import { z } from 'zod';

/**
 * Global search contracts (ADR-0007, ADR-0028, MVP_SPEC §M7).
 *
 * Shared by the API and the command palette, so what the palette sends and
 * what the API accepts cannot drift. `.strict()`, like every other contract:
 * an unknown key is a 422 rather than something quietly ignored
 * (CLAUDE.md §5.6).
 *
 * There is **no object-type filter** and **no cursor**. Both were left out on
 * purpose: a palette shows the best handful across everything and the next
 * keystroke is cheaper than a second page, and every parameter is one more
 * thing that has to be validated, authorized and tested on the product's
 * widest-reaching read path.
 */

export const searchableObjectTypeSchema = z.enum([
  'account',
  'contact',
  'lead',
  'deal',
  'activity',
]);

export type SearchableObjectTypeInput = z.infer<typeof searchableObjectTypeSchema>;

export const searchQuerySchema = z
  .object({
    /**
     * What was typed. Bounded because it is tokenized, and a query nobody
     * could type is a query somebody generated.
     */
    q: z.string().min(1).max(256),
    limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * One result.
 *
 * Three things here are the field-permission boundary, and each is built from
 * fields the caller may read and nothing else:
 *
 *   - `title` comes from the owning module's label, the same one an activity
 *     link shows, which is already built only from readable fields;
 *   - `matchedField` names the field that matched, which is always one the
 *     caller may read because the engine was told which keys to search;
 *   - `snippet` is that field's value, so a hidden field cannot be quoted
 *     back even by accident — the usual leak in a search feature, where the
 *     column is stripped from the payload but its text appears in the
 *     surrounding excerpt.
 */
export const searchResultSchema = z.object({
  objectType: searchableObjectTypeSchema,
  id: z.uuid(),
  title: z.string(),
  matchedField: z.string(),
  snippet: z.string(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;
