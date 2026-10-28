import {
  CONSENT_TEXT_MAX_LENGTH,
  CONSENT_TEXT_MIN_LENGTH,
  FORM_HELP_TEXT_MAX_LENGTH,
  FORM_LABEL_MAX_LENGTH,
  FORM_NAME_MAX_LENGTH,
  FORM_URL_MAX_LENGTH,
  MAX_ALLOWED_ORIGINS,
  MAX_FORM_FIELDS,
  SUCCESS_MESSAGE_MAX_LENGTH,
} from '@crm/core';
import { z } from 'zod';

/**
 * Website lead forms (ADR-0065).
 *
 * Two surfaces live here and they must not be confused:
 *
 *  - the **administration** schemas (`/lead-forms`, session and `lead_form` grant), which are
 *    ordinary: strict, versioned, authorised through `can()`;
 *  - the **public** schemas (`/public/forms/:key`), which are the only ones in the API a stranger
 *    reaches. The submission body has no fixed shape: it is built from the form's own field list
 *    (`buildSubmissionSchema` in `@crm/core`), so what is declared here is the part that never
 *    changes (the key, the envelope of the answer) and the OpenAPI document says so.
 *
 * Every object is `.strict()`: an unknown key is a 422, never something to drop quietly.
 */

export {
  CONSENT_TEXT_MAX_LENGTH,
  CONSENT_TEXT_MIN_LENGTH,
  FORM_HELP_TEXT_MAX_LENGTH,
  FORM_LABEL_MAX_LENGTH,
  FORM_NAME_MAX_LENGTH,
  MAX_ALLOWED_ORIGINS,
  MAX_FORM_FIELDS,
  SUCCESS_MESSAGE_MAX_LENGTH,
};

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export const leadFormStatusSchema = z.enum(['enabled', 'disabled']);
export type LeadFormStatus = z.infer<typeof leadFormStatusSchema>;

/** One field a form asks for. The key is a lead field key; the label is the company's own words. */
export const leadFormFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    label: z.string().trim().min(1).max(FORM_LABEL_MAX_LENGTH),
    required: z.boolean(),
    helpText: z.string().trim().max(FORM_HELP_TEXT_MAX_LENGTH).optional(),
  })
  .strict();
export type LeadFormFieldInput = z.infer<typeof leadFormFieldSchema>;

const nameSchema = z.string().trim().min(1).max(FORM_NAME_MAX_LENGTH);
const consentTextSchema = z
  .string()
  .trim()
  .min(
    CONSENT_TEXT_MIN_LENGTH,
    `The consent text is at least ${CONSENT_TEXT_MIN_LENGTH} characters`,
  )
  .max(CONSENT_TEXT_MAX_LENGTH);
const messageSchema = z.string().trim().min(1).max(SUCCESS_MESSAGE_MAX_LENGTH);
const urlSchema = z.string().trim().min(1).max(FORM_URL_MAX_LENGTH);
const originsSchema = z.array(z.string().trim().min(1).max(200)).max(MAX_ALLOWED_ORIGINS);
const phoneCodeSchema = z.string().regex(/^[1-9][0-9]{0,3}$/, 'Digits only, without a plus');

export const leadFormCreateSchema = z
  .object({
    name: nameSchema,
    fields: z.array(leadFormFieldSchema).min(1).max(MAX_FORM_FIELDS),
    consentText: consentTextSchema,
    privacyUrl: urlSchema.nullish(),
    successMessage: messageSchema,
    successRedirectUrl: urlSchema.nullish(),
    allowedOrigins: originsSchema.default([]),
    phoneCountryCode: phoneCodeSchema.nullish(),
  })
  .strict();
export type LeadFormCreateInput = z.infer<typeof leadFormCreateSchema>;

/** PATCH. Carries `version`, so an edit is never last-write-wins. */
export const leadFormUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    status: leadFormStatusSchema.optional(),
    fields: z.array(leadFormFieldSchema).min(1).max(MAX_FORM_FIELDS).optional(),
    consentText: consentTextSchema.optional(),
    privacyUrl: urlSchema.nullish(),
    successMessage: messageSchema.optional(),
    successRedirectUrl: urlSchema.nullish(),
    allowedOrigins: originsSchema.optional(),
    phoneCountryCode: phoneCodeSchema.nullish(),
    version: z.coerce.number().int().positive(),
  })
  .strict();
export type LeadFormUpdateInput = z.infer<typeof leadFormUpdateSchema>;

export const leadFormParamsSchema = z.object({ id: z.uuid() }).strict();
export type LeadFormParams = z.infer<typeof leadFormParamsSchema>;

export const leadFormDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export type LeadFormDeleteQuery = z.infer<typeof leadFormDeleteQuerySchema>;

/** How many leads a form has made. The only thing the list says about its traffic. */
export const leadFormStatsSchema = z.object({
  today: z.number().int(),
  last7Days: z.number().int(),
  total: z.number().int(),
  lastSubmittedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type LeadFormStats = z.infer<typeof leadFormStatsSchema>;

/** A form as the editor sees it. Never carries a key or a digest: those are shown once, at issue. */
export const leadFormSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: leadFormStatusSchema,
  fields: z.array(leadFormFieldSchema),
  consentText: z.string(),
  consentVersion: z.number().int(),
  privacyUrl: z.string().nullable(),
  successMessage: z.string(),
  successRedirectUrl: z.string().nullable(),
  allowedOrigins: z.array(z.string()),
  phoneCountryCode: z.string().nullable(),
  /** The last four characters of the key now in use, or null when every key is revoked. */
  keyHint: z.string().nullable(),
  /** When an older key stops working after a rotation, if one is still in its grace window. */
  previousKeyRetiresAt: z.iso.datetime({ offset: true }).nullable(),
  stats: leadFormStatsSchema,
  version: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type LeadForm = z.infer<typeof leadFormSchema>;

/**
 * What the screen needs to offer: the lead fields a form may ask for, whether all forms are paused,
 * and the calling code to pre-fill.
 */
export const leadFormFieldOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  /** True for the surname, which every form must ask for and require. */
  mandatory: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const leadFormSetupSchema = z.object({
  fields: z.array(leadFormFieldOptionSchema),
  paused: z.boolean(),
  defaultPhoneCountryCode: z.string().nullable(),
  /** How many forms a workspace may have, so the screen can say so before the 409. */
  maxForms: z.number().int(),
});
export type LeadFormSetup = z.infer<typeof leadFormSetupSchema>;

export const leadFormPauseSchema = z.object({ paused: z.boolean() }).strict();
export type LeadFormPauseInput = z.infer<typeof leadFormPauseSchema>;

/**
 * The answer to creating a form or rotating its key. **The only time the key is ever shown**: only
 * its digest is kept (ADR-0065 3.1).
 */
export const leadFormIssuedSchema = z.object({
  form: leadFormSchema,
  key: z.string(),
  link: z.string(),
  snippet: z.string(),
});
export type LeadFormIssued = z.infer<typeof leadFormIssuedSchema>;

export const leadFormRotateSchema = z
  .object({
    /** How long the old key keeps working, in hours. 0 retires it at once. */
    graceHours: z.number().int().min(0).max(168).default(24),
    version: z.number().int().positive(),
  })
  .strict();
export type LeadFormRotateInput = z.infer<typeof leadFormRotateSchema>;

export const leadFormRevokeSchema = z.object({ version: z.number().int().positive() }).strict();
export type LeadFormRevokeInput = z.infer<typeof leadFormRevokeSchema>;

// ---------------------------------------------------------------------------
// The public door (the only unauthenticated routes that write; ADR-0065 1)
// ---------------------------------------------------------------------------

/** The key in the path. Its shape is checked before anything else happens. */
export const publicFormParamsSchema = z.object({ key: z.string().max(100) }).strict();
export type PublicFormParams = z.infer<typeof publicFormParamsSchema>;

/** The public routes take no query string at all. */
export const publicFormQuerySchema = z.object({}).strict();

export const publicFormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  helpText: z.string().nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

/** What a visitor's page needs to draw the form. Nothing about the company beyond its own wording. */
export const publicFormDefinitionSchema = z.object({
  name: z.string(),
  fields: z.array(publicFormFieldSchema),
  consentText: z.string(),
  privacyUrl: z.string().nullable(),
  successMessage: z.string(),
  successRedirectUrl: z.string().nullable(),
  /** The origins that may frame the hosted page. The page's security headers are built from this. */
  allowedOrigins: z.array(z.string()),
  /** A token the page sends back with the submission; see ADR-0065 4.3. */
  fillToken: z.string(),
});
export type PublicFormDefinition = z.infer<typeof publicFormDefinitionSchema>;

/**
 * The submission's body is built per form, so what is declared is the open object the document
 * describes in prose. The route validates against the form's own strict schema.
 */
export const publicSubmissionBodySchema = z.record(z.string(), z.unknown());

/** Every accepted outcome (created, dropped as spam, repeated) answers with exactly this. */
export const publicSubmissionResultSchema = z.object({ received: z.literal(true) });
export type PublicSubmissionResult = z.infer<typeof publicSubmissionResultSchema>;
