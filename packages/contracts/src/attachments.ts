import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMITS,
  ATTACHMENT_TARGET_TYPES,
  attachmentFileNameProblem,
  type FileNameProblem,
} from '@crm/core';
import { z } from 'zod';

/**
 * Attachment contracts (MVP_SPEC §6.1, ADR-0035).
 *
 * Shared by the API and the record page. `.strict()` throughout, like every
 * other contract: an unknown key is a 422 rather than something to drop
 * quietly (CLAUDE.md §5.6).
 *
 * What is **absent** is the point of the file:
 *
 *   - **no `mime`**. The server decides the content type from the allow-listed
 *     extension; a client-supplied type is exactly the string §5.12 says not
 *     to believe, and it is the string that decides whether a browser renders
 *     or downloads the bytes.
 *   - **no file**, ever. A file never passes through the API: create returns a
 *     presigned PUT and the bytes go straight to the object store.
 *   - **no `fileKey`**, in or out. The storage key is never shown to a client.
 *   - **no PATCH**. An attachment is immutable once uploaded; a new version of
 *     a document is a new attachment, which also keeps the audit trail honest.
 */

export const attachmentTargetTypeSchema = z.enum(ATTACHMENT_TARGET_TYPES);
export type AttachmentTargetTypeInput = z.infer<typeof attachmentTargetTypeSchema>;

export const attachmentStatusSchema = z.enum(['awaiting_upload', 'scanning', 'ready', 'rejected']);
export type AttachmentStatusValue = z.infer<typeof attachmentStatusSchema>;

/**
 * Why a filename was refused, in words.
 *
 * Each case says what is wrong rather than "invalid file name", because the
 * person who chose `Q3 report (final).pdf` deserves to know it was the
 * parentheses — and because a message that names the rule is a message nobody
 * has to guess their way around.
 */
const FILE_NAME_MESSAGES: Readonly<Record<FileNameProblem, string>> = {
  empty: 'The file needs a name',
  too_long: `A file name may be at most ${ATTACHMENT_LIMITS.maxFileNameChars} characters`,
  path_separator: 'A file name cannot contain a slash or a backslash',
  traversal: 'A file name cannot contain ".."',
  control_character: 'The file name contains control characters',
  bidi_override: 'The file name contains text-direction overrides, which can disguise its type',
  extension_not_allowed: `Allowed file types: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')}`,
};

/**
 * The filename, judged by the same function the service and the UI use.
 *
 * One implementation in `@crm/core`, called here, so the browser can refuse a
 * file before uploading it and the API refuses the same files for the same
 * reasons — without the rule existing twice and drifting apart.
 */
export const attachmentFileNameSchema = z
  .string()
  .min(1)
  .max(ATTACHMENT_LIMITS.maxFileNameChars)
  .superRefine((name, ctx) => {
    const problem = attachmentFileNameProblem(name);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: FILE_NAME_MESSAGES[problem] });
    }
  });

export const attachmentCreateSchema = z
  .object({
    objectType: attachmentTargetTypeSchema,
    recordId: z.uuid(),
    fileName: attachmentFileNameSchema,
    /** Exact, because the presigned PUT is signed for exactly this many bytes. */
    sizeBytes: z.number().int().min(1).max(ATTACHMENT_LIMITS.maxUploadBytes),
  })
  .strict();

export type AttachmentCreateInput = z.infer<typeof attachmentCreateSchema>;

export const attachmentSchema = z.object({
  id: z.uuid(),
  objectType: attachmentTargetTypeSchema,
  recordId: z.uuid(),
  fileName: z.string(),
  /** The server's canonical type for the extension, not anything a client sent. */
  mime: z.string(),
  sizeBytes: z.number().int(),
  status: attachmentStatusSchema,
  /** A sentence for the user. Never a stack trace, never file content. */
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.uuid().nullable(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/** The presigned PUT, in the shape the import flow already uses. */
export const attachmentUploadSchema = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  /** Sent verbatim by the client; the signature is bound to them. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const attachmentCreateResultSchema = z.object({
  attachment: attachmentSchema,
  upload: attachmentUploadSchema,
});

export type AttachmentCreateResult = z.infer<typeof attachmentCreateResultSchema>;

export const attachmentParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * Listing is always "the files on one record".
 *
 * `objectType` and `recordId` are required rather than optional: a tenant-wide
 * list of every file would be a new and quite different permission question,
 * and there is no screen that asks it.
 */
export const attachmentListQuerySchema = z
  .object({
    objectType: attachmentTargetTypeSchema,
    recordId: z.uuid(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>;
