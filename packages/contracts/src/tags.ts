import { isValidTagName, normalizeTagName, TAG_COLORS, TAG_NAME_MAX } from '@crm/core';
import { z } from 'zod';

/**
 * Tag contracts (MVP_SPEC M4, ADR-0063).
 *
 * Adding a tag to a record and removing it are bulk actions of one record (ADR-0056); this file holds
 * what is new: the chip a record carries, and the administrator's rename, recolour and delete.
 */

export const tagColorSchema = z.enum(TAG_COLORS);

/** A tag as a record carries it: enough to draw the chip, nothing to edit it with. */
export const recordTagSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: tagColorSchema.nullable(),
});
export type RecordTag = z.infer<typeof recordTagSchema>;

export const tagNameSchema = z
  .string()
  .transform(normalizeTagName)
  .refine(isValidTagName, `Use 1 to ${TAG_NAME_MAX} characters on one line`);

export const tagParamsSchema = z.object({ id: z.uuid() }).strict();

/** PATCH body: a new name and/or colour (`null` removes the colour), and the version it was read at. */
export const tagUpdateSchema = z
  .object({
    name: tagNameSchema.optional(),
    color: tagColorSchema.nullable().optional(),
    version: z.coerce.number().int().positive(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.color !== undefined, {
    message: 'Change the name or the colour',
  });
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>;

export const tagDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export type TagDeleteQuery = z.infer<typeof tagDeleteQuerySchema>;

/** One tag with how many live records carry it, per kind, for the settings screen and the delete warning. */
export const tagUsageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: tagColorSchema.nullable(),
  version: z.number().int(),
  records: z.object({
    contact: z.number().int(),
    account: z.number().int(),
    lead: z.number().int(),
    deal: z.number().int(),
  }),
});
export type TagUsage = z.infer<typeof tagUsageSchema>;
