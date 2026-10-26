import { z } from 'zod';

/**
 * List query parameters (CLAUDE.md §8, ADR-0012).
 *
 * Keyset only: there is no `page` or `offset`, because at 1M records per tenant
 * OFFSET both misses the latency budget and skips or repeats rows when the data
 * changes between requests.
 */

/** Hard ceiling from CLAUDE.md §8. A client asking for more gets rejected. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * The shared shape of a list request.
 *
 * `sort` and `filter` arrive as untrusted strings and are validated against
 * field metadata by the service before they reach SQL (CLAUDE.md §5.7). The
 * schema only checks shape; it cannot know a tenant's custom fields.
 */
export const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    /** `field` or `-field`, where a leading minus means descending. */
    sort: z
      .string()
      .regex(/^-?[a-z][a-z0-9_]{0,62}$/, 'Sort must be a field key, optionally prefixed with -')
      .optional(),
    /** `field:operator:value`, repeated. Validated against field metadata. */
    filter: z.union([z.string(), z.array(z.string())]).optional(),
    /** Sparse fieldsets: a comma-separated list of field keys. */
    fields: z.string().max(2048).optional(),
    /** Free-text search across the object's searchable fields. */
    q: z.string().max(256).optional(),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;

/** Parse `-created_at` into its parts. */
export function parseSort(sort: string): { field: string; direction: SortDirection } {
  return sort.startsWith('-')
    ? { field: sort.slice(1), direction: 'desc' }
    : { field: sort, direction: 'asc' };
}

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'starts_with',
  'in',
  'is_null',
  'is_not_null',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const FILTER_OPERATOR_SET: ReadonlySet<string> = new Set(FILTER_OPERATORS);

export interface ParsedFilter {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string;
}

/**
 * Split `field:operator:value` without losing colons inside the value.
 *
 * Returns null rather than throwing so the caller decides whether a malformed
 * filter is a 422 or simply ignored. The field name is **not** validated here:
 * only the service knows the tenant's field metadata.
 */
export function parseFilter(raw: string): ParsedFilter | null {
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) return null;
  const secondColon = raw.indexOf(':', firstColon + 1);

  const field = raw.slice(0, firstColon);
  const operator =
    secondColon === -1 ? raw.slice(firstColon + 1) : raw.slice(firstColon + 1, secondColon);
  const value = secondColon === -1 ? '' : raw.slice(secondColon + 1);

  if (!FILTER_OPERATOR_SET.has(operator)) return null;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(field)) return null;

  return { field, operator: operator as FilterOperator, value };
}

/** Normalise the repeated `filter` parameter into a list. */
export function toFilterList(filter: string | readonly string[] | undefined): string[] {
  if (filter === undefined) return [];
  // Narrowing on `typeof` rather than Array.isArray: the latter widens a
  // readonly array to any[], which the no-unsafe-* rules correctly object to.
  return typeof filter === 'string' ? [filter] : [...filter];
}
