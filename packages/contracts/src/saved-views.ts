import {
  BUSINESS_OBJECT_TYPES,
  VIEW_MAX_COLUMNS,
  VIEW_MAX_CONDITIONS,
  VIEW_NAME_MAX,
  VIEW_VISIBILITIES,
} from '@crm/core';
import { z } from 'zod';
import { FILTER_OPERATORS } from './pagination.js';

/**
 * Saved view contracts (MVP_SPEC M4, ADR-0056).
 *
 * A saved view is a list's state under a name: the search, the filter conditions, the columns and
 * the sort. It stores **field keys and operators, never SQL and never record ids**, and nothing
 * here can name a field: whether a key is a real, active, readable field is decided against the
 * tenant's metadata and the caller's field permissions by the service, the same way the list
 * endpoint decides it. A schema cannot know a tenant's custom fields.
 */

export const savedViewObjectTypeSchema = z.enum(BUSINESS_OBJECT_TYPES);
export type SavedViewObjectType = z.infer<typeof savedViewObjectTypeSchema>;

export const viewVisibilitySchema = z.enum(VIEW_VISIBILITIES);

const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use a field key');

/** One filter condition, in the structured form the filter builder edits. */
export const viewConditionSchema = z
  .object({
    field: fieldKeySchema,
    operator: z.enum(FILTER_OPERATORS),
    /** Empty for `is_null` and `is_not_null`. Comma-separated for `in`, as in a list URL. */
    value: z.string().max(256),
  })
  .strict();
export type ViewCondition = z.infer<typeof viewConditionSchema>;

/** The search box and the conditions, together: everything that narrows which records show. */
export const viewFiltersSchema = z
  .object({
    q: z.string().trim().max(256).optional(),
    conditions: z.array(viewConditionSchema).max(VIEW_MAX_CONDITIONS).default([]),
  })
  .strict();
export type ViewFilters = z.infer<typeof viewFiltersSchema>;

export const viewSortSchema = z
  .object({ field: fieldKeySchema, direction: z.enum(['asc', 'desc']) })
  .strict();
export type ViewSort = z.infer<typeof viewSortSchema>;

const viewNameSchema = z.string().trim().min(1).max(VIEW_NAME_MAX);

export const savedViewCreateSchema = z
  .object({
    objectType: savedViewObjectTypeSchema,
    name: viewNameSchema,
    visibility: viewVisibilitySchema.default('private'),
    filters: viewFiltersSchema.default({ conditions: [] }),
    /** Field keys, in display order. Empty means the list's default columns. */
    columns: z.array(fieldKeySchema).max(VIEW_MAX_COLUMNS).default([]),
    /** At most one, because a list sorts by one key (ADR-0012). */
    sort: z.array(viewSortSchema).max(1).default([]),
  })
  .strict();
export type SavedViewCreateInput = z.infer<typeof savedViewCreateSchema>;

/** PATCH body: any of the editable parts, plus the `version` they were read at. */
export const savedViewUpdateSchema = z
  .object({
    name: viewNameSchema.optional(),
    visibility: viewVisibilitySchema.optional(),
    filters: viewFiltersSchema.optional(),
    columns: z.array(fieldKeySchema).max(VIEW_MAX_COLUMNS).optional(),
    sort: z.array(viewSortSchema).max(1).optional(),
    version: z.coerce.number().int().positive(),
  })
  .strict();
export type SavedViewUpdateInput = z.infer<typeof savedViewUpdateSchema>;

export const savedViewListQuerySchema = z
  .object({ objectType: savedViewObjectTypeSchema })
  .strict();
export type SavedViewListQuery = z.infer<typeof savedViewListQuerySchema>;

export const savedViewParamsSchema = z.object({ id: z.uuid() }).strict();

export const savedViewDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export type SavedViewDeleteQuery = z.infer<typeof savedViewDeleteQuerySchema>;

export const savedViewSchema = z.object({
  id: z.uuid(),
  objectType: savedViewObjectTypeSchema,
  name: z.string(),
  visibility: viewVisibilitySchema,
  filters: viewFiltersSchema,
  columns: z.array(z.string()),
  sort: z.array(viewSortSchema),
  /** The caller made it, so the caller may change or delete it. */
  isMine: z.boolean(),
  /**
   * False when the view uses a field this caller may not read. The view is still listed (it is
   * somebody's shared work) and says nothing about which field, so it cannot be used to learn that
   * a hidden field exists; applying it is not offered.
   */
  applicable: z.boolean(),
  version: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SavedView = z.infer<typeof savedViewSchema>;
