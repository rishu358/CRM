import { z } from 'zod';
import { moneySchema } from './accounts.js';
import { listQuerySchema } from './pagination.js';
import { recordTagSchema } from './tags.js';

/**
 * Lead API contracts (ADR-0007).
 *
 * Shared by the API and the web app, so request validation and form validation
 * cannot drift. Every object is `.strict()`: an unknown key is a 422, never
 * something to drop quietly (CLAUDE.md §5.6).
 *
 * What a client may **not** send is as deliberate as what it may. The
 * `converted*` columns and `convertedAt` are absent from the write schemas,
 * and `status` cannot be set to `converted` here: a lead becomes converted by
 * `POST /leads/:id/convert`, which creates or links the records it becomes in
 * the same transaction (ADR-0022). Letting a PATCH say "converted" would
 * produce exactly the half-converted lead that endpoint exists to prevent.
 */

const E164 = /^\+[1-9]\d{1,14}$/;

const nameSchema = z.string().trim().min(1).max(120);
const optionalNameSchema = z.string().trim().max(120);

/** Values for custom fields. Shape only here; meaning comes from metadata. */
const customFieldsSchema = z.record(z.string(), z.unknown());

/** The statuses a person may set by hand. `converted` is conversion's alone. */
export const leadOpenStatusSchema = z.enum(['new', 'contacted', 'qualified', 'unqualified']);

/** Every status a lead can be read as. */
export const leadStatusSchema = z.enum([
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'converted',
]);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

const emailSchema = z
  .email()
  .max(254)
  // Lowercased here so it matches the citext column and so duplicate detection
  // compares like with like (CLAUDE.md §7).
  .transform((value) => value.toLowerCase());

export const leadCreateSchema = z
  .object({
    firstName: optionalNameSchema.nullish(),
    lastName: nameSchema,
    company: z.string().trim().min(1).max(200).nullish(),
    email: emailSchema.nullish(),
    phone: z.string().regex(E164, 'Phone must be in E.164 format').nullish(),
    source: z.string().max(64).nullish(),
    status: leadOpenStatusSchema.optional(),
    /**
     * Omitted means "assign to me". A client may name another owner only if
     * `can()` permits reassignment — the server never trusts this value alone
     * (CLAUDE.md §5.2).
     */
    ownerId: z.uuid().nullish(),
    customFields: customFieldsSchema.optional(),
  })
  .strict();

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

/**
 * PATCH body. Every field optional, but `version` is required, so an edit is
 * never last-write-wins (MVP_SPEC M4 acceptance).
 */
export const leadUpdateSchema = leadCreateSchema
  .partial()
  .extend({
    version: z.coerce.number().int().positive(),
  })
  .strict();

export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

/**
 * What the API returns. Fields the caller may not read are stripped by the
 * serializer first, so the schema describes the maximum, not a guarantee.
 */
export const leadSchema = z.object({
  id: z.uuid(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().optional(),
  company: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  status: leadStatusSchema.optional(),
  ownerId: z.uuid().nullable().optional(),
  convertedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  convertedContactId: z.uuid().nullable().optional(),
  convertedAccountId: z.uuid().nullable().optional(),
  convertedDealId: z.uuid().nullable().optional(),
  customFields: customFieldsSchema.optional(),
  /** The tags on the record (ADR-0063). Anyone who can read the record sees them. */
  tags: recordTagSchema.array().optional(),
  version: z.number().int().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type Lead = z.infer<typeof leadSchema>;

export const leadListQuerySchema = listQuerySchema;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const leadParamsSchema = z.object({ id: z.uuid() }).strict();

/** DELETE carries the version for the same reason PATCH does. */
export const leadDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type LeadDeleteQuery = z.infer<typeof leadDeleteQuerySchema>;

// ---------------------------------------------------------------------------
// Duplicate detection (ADR-0023)
// ---------------------------------------------------------------------------

export const duplicateReasonSchema = z.enum(['email', 'phone', 'domain', 'name']);
export type DuplicateReason = z.infer<typeof duplicateReasonSchema>;

export const duplicateObjectTypeSchema = z.enum(['lead', 'contact', 'account']);
export type DuplicateObjectType = z.infer<typeof duplicateObjectTypeSchema>;

/**
 * What the pre-create check is given: the things a person has typed so far.
 * Every field is optional; a check with none of them matches nothing.
 */
export const duplicateCheckSchema = z
  .object({
    email: emailSchema.nullish(),
    phone: z.string().regex(E164, 'Phone must be in E.164 format').nullish(),
    company: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

export type DuplicateCheckInput = z.infer<typeof duplicateCheckSchema>;

/**
 * One record offered as a possible duplicate.
 *
 * Deliberately minimal: an id to link to, a label to recognise it by, and why
 * it matched. The label is built from fields the caller may read, so a match
 * never becomes a side door around field permissions (ADR-0023).
 */
export const duplicateMatchSchema = z.object({
  objectType: duplicateObjectTypeSchema,
  id: z.uuid(),
  label: z.string(),
  matchedOn: z.array(duplicateReasonSchema),
});

export type DuplicateMatch = z.infer<typeof duplicateMatchSchema>;

// ---------------------------------------------------------------------------
// Conversion (ADR-0022)
// ---------------------------------------------------------------------------

/** Create a new contact from the lead, or attach the lead to one that exists. */
export const convertContactSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }).strict(),
  z.object({ mode: z.literal('link'), contactId: z.uuid() }).strict(),
]);

/** `none` is for a lead with no company: a person, not a business. */
export const convertAccountSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }).strict(),
  z.object({ mode: z.literal('link'), accountId: z.uuid() }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
]);

export const convertDealSchema = z
  .object({
    /** Omitted means "<company or name> — opportunity". */
    name: z.string().trim().min(1).max(200).optional(),
    pipelineId: z.uuid().optional(),
    stageId: z.uuid().optional(),
    amount: moneySchema.nullish(),
    expectedCloseDate: z.iso.date().nullish(),
  })
  .strict();

export const leadConvertSchema = z
  .object({
    /** The version the caller read: a lead somebody else just edited is a 409. */
    version: z.coerce.number().int().positive(),
    /** Omitted means create. */
    contact: convertContactSchema.optional(),
    /** Omitted means create when the lead has a company, none when it has not. */
    account: convertAccountSchema.optional(),
    /** Absent or null means no deal. */
    deal: convertDealSchema.nullish(),
    /**
     * "I have seen the matches and want a new record anyway." Without it,
     * creating a contact or account that matches an existing one is a 409
     * `DUPLICATE_RECORDS` rather than a silent duplicate (ADR-0023).
     */
    acknowledgeDuplicates: z.boolean().default(false),
  })
  .strict();

export type LeadConvertInput = z.input<typeof leadConvertSchema>;
export type LeadConvertRequest = z.output<typeof leadConvertSchema>;

/** A record the conversion created or linked. */
export const convertedRecordSchema = z.object({
  id: z.uuid(),
  /** True when the conversion made it, false when it attached to an existing one. */
  created: z.boolean(),
});

export const leadConversionResultSchema = z.object({
  lead: leadSchema,
  contact: convertedRecordSchema,
  account: convertedRecordSchema.nullable(),
  deal: z.object({ id: z.uuid() }).nullable(),
  /**
   * Fields the caller could not copy across because they may not read them on
   * the lead or may not write them on the target. Reported, never silently
   * dropped (ADR-0022).
   */
  skippedFields: z.array(z.string()),
});

export type LeadConversionResult = z.infer<typeof leadConversionResultSchema>;
