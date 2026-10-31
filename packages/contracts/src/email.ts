import {
  EMAIL_FAILURE_CODES,
  EMAIL_SOURCE_TYPES,
  EMAIL_STATUSES,
  EMAIL_BODY_MAX,
  EMAIL_FOOTER_MAX,
  EMAIL_FROM_NAME_MAX,
  EMAIL_MERGE_FIELDS,
  EMAIL_SIGNATURE_MAX,
  EMAIL_SUBJECT_MAX,
  EMAIL_TEMPLATE_NAME_MAX,
  isValidBody,
  isValidFooter,
  isValidFromName,
  isValidReplyTo,
  isValidSignature,
  isValidSubject,
  isValidTemplateName,
  normalizeSingleLine,
  unknownEmailMergeFields,
} from '@crm/core';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination.js';

/**
 * Email sent from a record, and the log of it (MVP_SPEC M11, ADR-0073).
 *
 * Every request schema is `.strict()`: the recipient, the sender address, the status and any link
 * target other than the record are never the client's to name (CLAUDE.md §5.2).
 */

export const emailSourceTypeSchema = z.enum(EMAIL_SOURCE_TYPES);
export const emailStatusSchema = z.enum(EMAIL_STATUSES);
export const emailFailureCodeSchema = z.enum(EMAIL_FAILURE_CODES);

/** A line break in a header is how mail gets injected: refuse it, do not quietly flatten it. */
function oneLine(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** A field between double braces that is not on the list is refused, never sent as typed (ADR-0074). */
const knownFieldsOnly = (value: string): boolean => unknownEmailMergeFields(value).length === 0;
const UNKNOWN_FIELD = `Use only these fields: ${EMAIL_MERGE_FIELDS.map((name) => `{{${name}}}`).join(', ')}`;

export const emailSubjectSchema = z
  .string()
  .refine(oneLine, 'A subject is one line')
  .transform(normalizeSingleLine)
  .refine(isValidSubject, `Use 1 to ${EMAIL_SUBJECT_MAX} characters on one line`)
  .refine(knownFieldsOnly, UNKNOWN_FIELD);

export const emailBodySchema = z
  .string()
  .refine(isValidBody, `Write a message of up to ${EMAIL_BODY_MAX} characters`)
  .refine(knownFieldsOnly, UNKNOWN_FIELD);

export const emailParamsSchema = z.object({ id: z.uuid() }).strict();

/** Where an email is sent from. For a deal, `contactId` is which of its people it is written to. */
const targetShape = {
  objectType: emailSourceTypeSchema,
  recordId: z.uuid(),
  contactId: z.uuid().optional(),
};

function contactRule(value: { objectType: string; contactId?: string | undefined }): boolean {
  return value.objectType === 'deal'
    ? value.contactId !== undefined
    : value.contactId === undefined;
}
const CONTACT_RULE_MESSAGE =
  'A deal needs the contact it is written to; a contact or a lead takes none';

export const emailSendSchema = z
  .object({ ...targetShape, subject: emailSubjectSchema, body: emailBodySchema })
  .strict()
  .refine(contactRule, { message: CONTACT_RULE_MESSAGE, path: ['contactId'] });
export type EmailSendInput = z.infer<typeof emailSendSchema>;

/** What the Send dialog needs to know before it is filled in. */
export const emailContextQuerySchema = z
  .object(targetShape)
  .strict()
  .refine(contactRule, { message: CONTACT_RULE_MESSAGE, path: ['contactId'] });
export type EmailContextQuery = z.infer<typeof emailContextQuerySchema>;

export const emailListQuerySchema = z
  .object({
    objectType: emailSourceTypeSchema,
    recordId: z.uuid(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();
export type EmailListQuery = z.infer<typeof emailListQuerySchema>;

export const emailMessageSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['outbound', 'inbound']),
  status: emailStatusSchema,
  fromName: z.string(),
  /** Null once an erasure scrubbed the message. */
  toAddress: z.string().nullable(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  failureCode: emailFailureCodeSchema.nullable(),
  /** True when a person's erasure scrubbed the address, subject and body. */
  erased: z.boolean(),
  contactId: z.uuid().nullable(),
  sentById: z.uuid().nullable(),
  sentByName: z.string().nullable(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  /** The email this one is a second try of. */
  retryOfId: z.uuid().nullable(),
  /** Set when somebody has already tried this one again, so the screen offers no second retry. */
  retriedById: z.uuid().nullable(),
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;

export const emailUsageSchema = z.object({
  /** What this person has sent today, in the company's time zone. */
  sentToday: z.number().int(),
  limitPerUser: z.number().int(),
  /** What the whole company has sent today, and its limit. */
  tenantSentToday: z.number().int(),
  limitPerTenant: z.number().int(),
});
export type EmailUsage = z.infer<typeof emailUsageSchema>;

export const emailContextSchema = z.object({
  /** Null when the record has no address the caller may use. The screen explains; it never says "hidden". */
  to: z.string().nullable(),
  toName: z.string().nullable(),
  /** `withdrawn` blocks the send; `none` means no consent is recorded (a notice, not a block). */
  consent: z.enum(['recorded', 'none', 'withdrawn']),
  fromName: z.string(),
  /** Where a reply will go. */
  replyTo: z.string(),
  usage: emailUsageSchema,
  /** Whether the sender has been set up, or is still using the company name as a default. */
  senderConfigured: z.boolean(),
  /**
   * What each merge field would be for this person, as the caller may read it: an empty string where
   * there is nothing (or nothing they may see). The dialog previews with it; the server fills the real
   * ones when the email is queued (ADR-0074).
   */
  mergeValues: z.record(z.string(), z.string()),
  /** The lines this person's emails end with, or an empty string. */
  signature: z.string(),
});
export type EmailContext = z.infer<typeof emailContextSchema>;

export const emailSettingsSchema = z.object({
  fromName: z.string(),
  replyTo: z.string().nullable(),
  footerText: z.string().nullable(),
  /** Null until somebody has saved the settings once. */
  version: z.number().int().nullable(),
  /** The address mail is sent from: read-only, set by whoever runs this installation. */
  sendingAddress: z.string().nullable(),
  /** The company's name, which `fromName` starts as. */
  defaultFromName: z.string(),
  usage: emailUsageSchema,
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const emailSettingsUpdateSchema = z
  .object({
    fromName: z
      .string()
      .refine(oneLine, 'A name is one line')
      .transform(normalizeSingleLine)
      .refine(
        isValidFromName,
        `Use 1 to ${EMAIL_FROM_NAME_MAX} letters, digits and . , & ' ( ) - /, with no @ or brackets`,
      ),
    replyTo: z
      .string()
      .trim()
      .refine(isValidReplyTo, 'Use one plain email address, such as sales@example.com')
      .nullable(),
    footerText: z
      .string()
      .refine(isValidFooter, `Use at most ${EMAIL_FOOTER_MAX} characters`)
      .nullable(),
    /** Absent the first time; the version read thereafter. */
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type EmailSettingsUpdateInput = z.infer<typeof emailSettingsUpdateSchema>;

// ---- templates and signatures (ADR-0074) ---------------------------------------------------------------------

const templateNameSchema = z
  .string()
  .refine(oneLine, 'A name is one line')
  .transform(normalizeSingleLine)
  .refine(isValidTemplateName, `Use 1 to ${EMAIL_TEMPLATE_NAME_MAX} characters on one line`);

export const emailTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const emailTemplateCreateSchema = z
  .object({ name: templateNameSchema, subject: emailSubjectSchema, body: emailBodySchema })
  .strict();
export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>;

export const emailTemplateUpdateSchema = z
  .object({
    name: templateNameSchema.optional(),
    subject: emailSubjectSchema.optional(),
    body: emailBodySchema.optional(),
    version: z.coerce.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.subject !== undefined || value.body !== undefined,
    { message: 'Change the name, the subject or the message' },
  );
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>;

export const emailTemplateDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export type EmailTemplateDeleteQuery = z.infer<typeof emailTemplateDeleteQuerySchema>;

/** The person's own signature. `version` is null until they have saved one. */
export const emailSignatureSchema = z.object({
  text: z.string(),
  version: z.number().int().nullable(),
});
export type EmailSignature = z.infer<typeof emailSignatureSchema>;

export const emailSignatureUpdateSchema = z
  .object({
    text: z.string().refine(isValidSignature, `Use at most ${EMAIL_SIGNATURE_MAX} characters`),
    /** Absent the first time; the version read thereafter. */
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type EmailSignatureUpdateInput = z.infer<typeof emailSignatureUpdateSchema>;
