import { z } from 'zod';

/**
 * Response shapes (CLAUDE.md §8, ADR-0007).
 *
 * Every success is `{ data, meta }` and every failure is
 * `{ error: { code, message, details, requestId } }`. One shape means a client
 * can handle errors generically, and `requestId` ties a user's screenshot to
 * the exact log line without anyone guessing.
 */

export const errorDetailSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    /** Stable and machine-readable. May be added to, never renamed. */
    code: z.string(),
    /** For humans. May change without a version bump. */
    message: z.string(),
    details: z.array(errorDetailSchema).default([]),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Paging information returned alongside a list. */
export const listMetaSchema = z.object({
  /**
   * Opaque. Clients pass it back verbatim and never parse or construct one —
   * its encoding is ours to change (ADR-0012).
   */
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  /**
   * Present, and true, only when the request had a search (`q`) and more records matched than a
   * search may return (ADR-0041 §5). The list is then the most recently updated matches, not all of
   * them; a client says so rather than letting the first few hundred pass for everything.
   */
  truncated: z.boolean().optional(),
});

export type ListMeta = z.infer<typeof listMetaSchema>;

export function dataResponseSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: z.record(z.string(), z.unknown()).optional() });
}

export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: listMetaSchema });
}
