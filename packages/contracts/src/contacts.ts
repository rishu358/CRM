import { z } from 'zod';
import { listQuerySchema } from './pagination.js';

/**
 * Contact API contracts (ADR-0007).
 *
 * Shared by the API and the web app, so request validation and form validation
 * cannot drift. Every object is `.strict()`: an unknown key is a 422, never
 * something to drop quietly (CLAUDE.md §5.6).
 *
 * Standard fields are declared here; a tenant's **custom** fields cannot be,
 * because they differ per tenant. `customFields` is therefore a passthrough
 * record at this layer and is validated against `field_definitions` in the
 * service, using the generated schema from @crm/core/fields.
 */

const E164 = /^\+[1-9]\d{1,14}$/;

const nameSchema = z.string().trim().min(1).max(120);
const optionalNameSchema = z.string().trim().max(120);

/** Values for custom fields. Shape only here; meaning comes from metadata. */
const customFieldsSchema = z.record(z.string(), z.unknown());

/**
 * What the check made before saving a contact is given: the things a person has typed so far
 * (ADR-0023). Every field is optional; a check with none of them matches nothing.
 */
export const contactDuplicateCheckSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .nullish(),
    phone: z.string().regex(E164, 'Phone must be in E.164 format').nullish(),
  })
  .strict();

export type ContactDuplicateCheckInput = z.infer<typeof contactDuplicateCheckSchema>;

export const contactCreateSchema = z
  .object({
    firstName: optionalNameSchema.nullish(),
    lastName: nameSchema,
    // Lowercased here so it matches the citext column and so duplicate
    // detection compares like with like (CLAUDE.md §7).
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .nullish(),
    phone: z.string().regex(E164, 'Phone must be in E.164 format').nullish(),
    whatsapp: z.string().regex(E164, 'WhatsApp must be in E.164 format').nullish(),
    title: optionalNameSchema.nullish(),
    accountId: z.uuid().nullish(),
    leadSource: z.string().max(64).nullish(),
    /**
     * Omitted means "assign to me". A client may name another owner only if
     * `can()` permits reassignment — the server never trusts this value alone
     * (CLAUDE.md §5.2).
     */
    ownerId: z.uuid().nullish(),
    customFields: customFieldsSchema.optional(),
  })
  .strict();

export type ContactCreateInput = z.infer<typeof contactCreateSchema>;

/**
 * PATCH body. Every field optional, but `version` is required.
 *
 * Without the version an edit would be last-write-wins, and two reps on the
 * same contact would silently overwrite each other (MVP_SPEC M4 acceptance).
 * A stale version is a 409, not a clobber.
 */
export const contactUpdateSchema = contactCreateSchema
  .partial()
  .extend({
    version: z.coerce.number().int().positive(),
  })
  .strict();

export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

/**
 * What the API returns.
 *
 * Fields the caller may not read are stripped by the serializer before this is
 * built, so a response legitimately may not contain every key here — the schema
 * describes the maximum, not a guarantee.
 */
export const contactSchema = z.object({
  id: z.uuid(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  whatsapp: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  accountId: z.uuid().nullable().optional(),
  leadSource: z.string().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  customFields: customFieldsSchema.optional(),
  version: z.number().int().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type Contact = z.infer<typeof contactSchema>;

export const contactListQuerySchema = listQuerySchema;
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

/** Path parameter for the single-record routes. */
export const contactParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * DELETE carries the version for the same reason PATCH does: deleting a record
 * somebody else has just edited should fail loudly rather than quietly win.
 */
export const contactDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type ContactDeleteQuery = z.infer<typeof contactDeleteQuerySchema>;
