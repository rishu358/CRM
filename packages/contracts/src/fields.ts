import {
  CUSTOMIZABLE_OBJECTS,
  CUSTOM_FIELD_TYPES,
  FIELD_TYPES,
  HELP_TEXT_MAX_LENGTH,
  LABEL_MAX_LENGTH,
  MAX_CUSTOM_FIELDS_PER_OBJECT,
  MAX_PICKLIST_OPTIONS,
  SECTION_MAX_LENGTH,
  isPicklistType,
} from '@crm/core';
import { z } from 'zod';

/**
 * Custom fields and picklists (MVP_SPEC M9, ADR-0039).
 *
 * Every object is `.strict()`: a body naming `key`, `type` on an edit, `isSystem`,
 * `tenantId` or `pattern` is a 422, never something quietly ignored. What an
 * administrator may change after creation is spelled out in the update schema,
 * and the database grants say the same thing from the other side (migration 0019).
 */

export const customizableObjectSchema = z.enum(CUSTOMIZABLE_OBJECTS);
export type CustomizableObjectName = z.infer<typeof customizableObjectSchema>;

/** Every type a definition can *have*, system fields included. */
export const fieldTypeSchema = z.enum(FIELD_TYPES);

/** The types an administrator can *create*: `user_lookup` waits for a member picker. */
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);

const labelSchema = z
  .string()
  .trim()
  .min(1, 'Give the field a name')
  .max(LABEL_MAX_LENGTH, `Use at most ${LABEL_MAX_LENGTH} characters`);

const helpTextSchema = z.string().trim().min(1).max(HELP_TEXT_MAX_LENGTH);
const sectionSchema = z.string().trim().min(1).max(SECTION_MAX_LENGTH);

/** What is stored for one option, and what a reader receives. */
export const picklistOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  isActive: z.boolean().optional(),
});

/**
 * One option as submitted. An option that already exists is named by its `value`;
 * a new one has none, and is given one made from its label (ADR-0039).
 */
export const picklistOptionInputSchema = z
  .object({
    value: z.string().max(63).optional(),
    label: z.string().max(LABEL_MAX_LENGTH * 2),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * The limits an administrator can set. Deliberately **not** `pattern`: a pattern is
 * a program the server runs on every write, and needs a time-bounded engine first.
 */
export const fieldLimitsSchema = z
  .object({
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    min: z.string().max(24).optional(),
    max: z.string().max(24).optional(),
    allowedCurrencies: z.array(z.string().max(3)).max(20).optional(),
  })
  .strict();

/** A definition as the API returns it. */
export const fieldDefinitionSchema = z.object({
  id: z.uuid(),
  objectType: customizableObjectSchema,
  key: z.string(),
  label: z.string(),
  type: fieldTypeSchema,
  required: z.boolean(),
  options: z.array(picklistOptionSchema).optional(),
  validation: fieldLimitsSchema.optional(),
  helpText: z.string().nullable(),
  section: z.string().nullable(),
  position: z.number().int(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
  /** Whether the caller may write it, so a screen does not offer a box the API will refuse. */
  writable: z.boolean(),
  version: z.number().int(),
});
export type FieldDefinitionView = z.infer<typeof fieldDefinitionSchema>;

export const fieldListQuerySchema = z
  .object({
    objectType: customizableObjectSchema,
    /** Administrators only: the deactivated ones too, so they can be turned back on. */
    includeInactive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
export type FieldListQuery = z.infer<typeof fieldListQuerySchema>;

export const fieldCreateSchema = z
  .object({
    objectType: customizableObjectSchema,
    label: labelSchema,
    type: customFieldTypeSchema,
    required: z.boolean().optional(),
    options: z.array(picklistOptionInputSchema).optional(),
    validation: fieldLimitsSchema.optional(),
    helpText: helpTextSchema.nullish(),
    section: sectionSchema.nullish(),
  })
  .strict()
  .superRefine((body, context) => {
    const picklist = isPicklistType(body.type);
    if (picklist && (body.options === undefined || body.options.length === 0)) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
    }
    if (!picklist && body.options !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only a picklist has options',
      });
    }
    body.options?.forEach((option, index) => {
      if (option.value !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['options', index, 'value'],
          message: 'A new option is given its value; do not send one',
        });
      }
    });
  });
export type FieldCreateInput = z.infer<typeof fieldCreateSchema>;

export const fieldUpdateSchema = z
  .object({
    /** The version the editor read: a stale one is a 409, never a silent overwrite. */
    version: z.number().int().min(1),
    label: labelSchema.optional(),
    required: z.boolean().optional(),
    options: z.array(picklistOptionInputSchema).optional(),
    validation: fieldLimitsSchema.optional(),
    helpText: helpTextSchema.nullable().optional(),
    section: sectionSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'Nothing to change',
  });
export type FieldUpdateInput = z.infer<typeof fieldUpdateSchema>;

export const fieldParamsSchema = z.object({ id: z.uuid() }).strict();

/** The new order of every custom field of one object, first to last. */
export const fieldOrderSchema = z
  .object({
    objectType: customizableObjectSchema,
    ids: z.array(z.uuid()).min(1).max(MAX_CUSTOM_FIELDS_PER_OBJECT),
  })
  .strict();
export type FieldOrderInput = z.infer<typeof fieldOrderSchema>;

export { MAX_CUSTOM_FIELDS_PER_OBJECT, MAX_PICKLIST_OPTIONS };
