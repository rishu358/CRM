import { isTimeZone } from '@crm/core';
import { z } from 'zod';

/**
 * Company setup, the setup checklist and sample data (MVP_SPEC M2, ADR-0037).
 *
 * Nothing in any request here names a tenant. The company being edited is the
 * one on the caller's session, read from the server (CLAUDE.md §5.2); a body
 * carrying `tenantId`, `plan`, `status`, `slug` or `region` is a 422 because
 * every object is `.strict()`, not something quietly ignored. Those columns are
 * not even writable by the application's database role (migration 0017), so the
 * contract and the grant say the same thing from two directions.
 */

/**
 * The industries the setup screen offers.
 *
 * A list here rather than in the database so that adding one is a code change
 * and not a migration; the column only bounds the length. `other` exists
 * because a company that fits none of these is not a mistake to be corrected.
 */
export const INDUSTRIES = [
  'retail',
  'wholesale',
  'manufacturing',
  'services',
  'real_estate',
  'education',
  'healthcare',
  'technology',
  'hospitality',
  'other',
] as const;

export const industrySchema = z.enum(INDUSTRIES);
export type Industry = z.infer<typeof industrySchema>;

/**
 * ISO-4217 codes the runtime knows.
 *
 * `toCurrency` in `@crm/core` only checks the shape (three capital letters),
 * which would accept "XYZ" as a company's default currency and then fail to
 * convert anything into it, quietly, on every dashboard. The runtime's own list
 * is the cheap, current, dependency-free answer to "is this a real currency".
 */
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, such as INR')
  .refine((code) => KNOWN_CURRENCIES.has(code), 'That is not a currency code we recognise');

export const timeZoneSchema = z
  .string()
  .max(64)
  // Annotated as returning `boolean`: left to inference, TypeScript turns this into a
  // type predicate and the schema's output becomes the branded `TimeZone`, which
  // would leak into every form and request type that touches it.
  .refine((value): boolean => isTimeZone(value), 'That is not a time zone we recognise');

export const companyNameSchema = z.string().trim().min(1).max(120);

/** What is stored about the company, as the setup and settings screens read it. */
export const tenantProfileSchema = z.object({
  name: z.string(),
  defaultCurrency: z.string(),
  timezone: z.string(),
  locale: z.string(),
  industry: industrySchema.nullable(),
});

export type TenantProfile = z.infer<typeof tenantProfileSchema>;

/**
 * Editing the company profile.
 *
 * Every field is optional so a screen can change one thing, but an empty body is
 * refused: a PATCH that changes nothing is a mistake worth saying so about, and
 * would otherwise write an audit row for no change at all.
 */
export const tenantProfileUpdateSchema = z
  .object({
    name: companyNameSchema.optional(),
    defaultCurrency: currencyCodeSchema.optional(),
    timezone: timeZoneSchema.optional(),
    industry: industrySchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change');

export type TenantProfileUpdateInput = z.infer<typeof tenantProfileUpdateSchema>;

/** The things the checklist asks a new company to do, in the order it asks. */
export const CHECKLIST_KEYS = [
  'invite_team',
  'import_contacts',
  'add_first_deal',
  'set_email_sender',
] as const;
export const checklistKeySchema = z.enum(CHECKLIST_KEYS);
export type ChecklistKey = z.infer<typeof checklistKeySchema>;

export const checklistItemSchema = z.object({
  key: checklistKeySchema,
  done: z.boolean(),
});

/**
 * How many records of each kind. Used for what sample data created and for what
 * removing it took away, so the screen can say exactly what happened.
 */
export const recordCountsSchema = z.object({
  accounts: z.number().int().nonnegative(),
  contacts: z.number().int().nonnegative(),
  leads: z.number().int().nonnegative(),
  deals: z.number().int().nonnegative(),
  activities: z.number().int().nonnegative(),
});

export type RecordCounts = z.infer<typeof recordCountsSchema>;

export const onboardingStatusSchema = z.object({
  /** False sends a founding administrator to the setup screen. */
  setupCompleted: z.boolean(),
  checklist: z.array(checklistItemSchema),
  sampleData: z.object({
    /** True while any sample record is still registered. */
    present: z.boolean(),
    counts: recordCountsSchema,
    /**
     * True while a removal has been asked for and the worker has not finished it.
     * Derived from the outbox, not stored: a pending removal event *is* the state,
     * so there is nothing to forget to clear if the job fails or is retried.
     */
    removing: z.boolean(),
  }),
});

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

export const sampleDataLoadedSchema = z.object({ created: recordCountsSchema });
export type SampleDataLoaded = z.infer<typeof sampleDataLoadedSchema>;

/**
 * Removal is accepted, not performed, by the request that asks for it.
 *
 * It deletes from the search and timeline projections as well as the records, and
 * the application's database role is deliberately unable to write those (search
 * is read-only to it, migration 0011). So the work runs in the worker, the same
 * way the Recycle Bin's purge does, and the screen watches `sampleData.removing`
 * until it clears. What was kept is not reported here: those records are simply
 * still in the lists, and the audit log records exactly what was removed and kept.
 */
export const sampleDataRemovalSchema = z.object({ status: z.literal('removing') });
export type SampleDataRemoval = z.infer<typeof sampleDataRemovalSchema>;
