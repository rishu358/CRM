import { z } from 'zod';
import { listQuerySchema } from './pagination.js';

/**
 * Account API contracts (ADR-0007).
 *
 * Shared by the API and the web forms, so request validation and form
 * validation cannot drift. Every object is `.strict()`: an unknown key is a
 * 422, never something to drop quietly (CLAUDE.md §5.6).
 *
 * Where contacts made a choice that only makes sense for a person — a surname,
 * a WhatsApp number, per-channel consent — an account needs its own. The three
 * that are genuinely different are commented where they are declared: `domain`
 * is normalised because duplicate detection compares it, `annualRevenue` is
 * money and therefore never a number, and `parentAccountId` is a reference
 * into this same table.
 */

const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * A bare hostname: `acme.example`, not `https://acme.example/pricing`.
 *
 * Normalised to lower case because duplicate detection on import compares
 * domains (MVP_SPEC M4), and `Acme.Example` and `acme.example` are the same
 * company. A URL belongs in `website`; accepting one here would make every
 * comparison depend on whether somebody pasted a trailing slash.
 */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOSTNAME, 'Domain must be a hostname such as acme.example, without https:// or a path');

/**
 * India's GST identification number: 2 state digits, a 10-character PAN, an
 * entity digit, a fixed Z, and a checksum character. Upper-cased first,
 * because every government portal prints it in capitals and a lower-case copy
 * is the same number.
 */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN, 'GSTIN must be 15 characters, for example 29ABCDE1234F1Z5');

/**
 * http(s) only. A `javascript:` or `data:` URL rendered as a link on the record
 * page is an XSS vector, and no other scheme is any use to a CRM. The same
 * rule is applied to custom `url` fields in @crm/core/fields.
 */
const websiteSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Website must be an http or https URL');

/**
 * A postal address, stored as jsonb.
 *
 * `.strict()` for the same reason the top-level body is: jsonb accepts
 * anything, so without it a client could park arbitrary keys in a column
 * nothing validates, and the first code to read them would be surprised.
 */
export const addressSchema = z
  .object({
    line1: z.string().trim().max(200).nullish(),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().max(100).nullish(),
    state: z.string().trim().max(100).nullish(),
    postalCode: z.string().trim().max(32).nullish(),
    /** ISO 3166-1 alpha-2, upper-cased. */
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Country must be a two-letter ISO country code')
      .nullish(),
  })
  .strict();

export type AddressInput = z.infer<typeof addressSchema>;

/**
 * Money on the wire (ADR-0011, CLAUDE.md §7).
 *
 * `amountMinor` is a **decimal string**, not a JSON number. JSON has no
 * integer type past 2^53 and no decimal type at all, so a large revenue sent
 * as a number would lose precision somewhere between the browser and the
 * bigint column, silently and only for the biggest customers. The same
 * convention is used for `currency` custom fields.
 */
export const moneySchema = z
  .object({
    amountMinor: z.string().regex(/^\d{1,19}$/, 'Must be whole minor units as a string'),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Must be an ISO-4217 currency code'),
  })
  .strict();

export type MoneyInput = z.infer<typeof moneySchema>;

/** Values for custom fields. Shape only here; meaning comes from metadata. */
const customFieldsSchema = z.record(z.string(), z.unknown());

export const accountCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    domain: domainSchema.nullish(),
    industry: z.string().trim().max(120).nullish(),
    phone: z.string().regex(E164, 'Phone must be in E.164 format').nullish(),
    // Lowercased so it matches the citext column and duplicate detection
    // compares like with like (CLAUDE.md §7).
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .nullish(),
    website: websiteSchema.nullish(),
    gstin: gstinSchema.nullish(),
    billingAddress: addressSchema.nullish(),
    shippingAddress: addressSchema.nullish(),
    annualRevenue: moneySchema.nullish(),
    employeeCount: z.number().int().min(0).max(10_000_000).nullish(),
    /**
     * The parent company, in this tenant.
     *
     * That it exists, is not deleted and does not close a cycle is settled by
     * the service and, underneath it, by the database (ADR-0018). A schema can
     * only say "this is a uuid".
     */
    parentAccountId: z.uuid().nullish(),
    /**
     * Omitted means "assign to me". A client may name another owner only if
     * `can()` permits reassignment — the server never trusts this value alone
     * (CLAUDE.md §5.2).
     */
    ownerId: z.uuid().nullish(),
    customFields: customFieldsSchema.optional(),
  })
  .strict();

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/**
 * PATCH body. Every field optional, but `version` is required.
 *
 * Without the version an edit would be last-write-wins, and two reps on the
 * same account would silently overwrite each other (MVP_SPEC M4 acceptance).
 * A stale version is a 409, not a clobber.
 */
export const accountUpdateSchema = accountCreateSchema
  .partial()
  .extend({
    version: z.coerce.number().int().positive(),
  })
  .strict();

export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

/**
 * What the API returns.
 *
 * Fields the caller may not read are stripped by the serializer before this is
 * built, so a response legitimately may not contain every key here — the
 * schema describes the maximum, not a guarantee.
 */
export const accountSchema = z.object({
  id: z.uuid(),
  name: z.string().optional(),
  domain: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  gstin: z.string().nullable().optional(),
  billingAddress: addressSchema.nullable().optional(),
  shippingAddress: addressSchema.nullable().optional(),
  annualRevenue: moneySchema.nullable().optional(),
  employeeCount: z.number().int().nullable().optional(),
  parentAccountId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  customFields: customFieldsSchema.optional(),
  version: z.number().int().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type Account = z.infer<typeof accountSchema>;

export const accountListQuerySchema = listQuerySchema;
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

/** Path parameter for the single-record routes. */
export const accountParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * DELETE carries the version for the same reason PATCH does: deleting a record
 * somebody else has just edited should fail loudly rather than quietly win.
 */
export const accountDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type AccountDeleteQuery = z.infer<typeof accountDeleteQuerySchema>;
