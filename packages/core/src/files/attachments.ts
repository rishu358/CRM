/**
 * What may be attached to a record, and what we will say it is on the way
 * back out (CLAUDE.md §5.12, ADR-0035).
 *
 * An attachment is unlike every other record the product stores: it is a file
 * one user supplies and another user downloads. Three of its properties are
 * attacker-controlled and each one lands somewhere dangerous —
 *
 *   - the **filename** ends up in a `Content-Disposition` header and in a
 *     save dialog, so it can carry header syntax, path separators or a
 *     right-to-left override that makes `report.exe` read as `report.txt`;
 *   - the **declared type** decides what a browser does with the bytes, and a
 *     browser that renders rather than downloads is a browser executing
 *     somebody's document on an origin that holds a session;
 *   - the **bytes** are whatever the uploader liked, whatever the name says.
 *
 * The answer here is an **extension allow-list, closed by default**, with a
 * canonical type per extension that the server — never the client — decides,
 * and a byte check that must agree with it. `image/svg+xml`, `text/html` and
 * `application/xml` are absent on purpose: each is a document that can carry
 * script, and "we serve it as an attachment" is one control where three are
 * wanted. Adding one back is a decision for an ADR, not for a config file.
 */

import { matchFileSignature, startsWith, textProblem, UTF8_BOM } from './signatures.js';
import type { KnownFileFormat } from './signatures.js';

/** Hard limits on one attachment (CLAUDE.md §5.12). Constants, not settings. */
export const ATTACHMENT_LIMITS = {
  /**
   * What a presigned upload may carry; signed into the URL, so the store
   * refuses a body of any other length. The same ceiling as an import, because
   * one number is easier to defend than two and nothing about an attachment
   * argues for more.
   */
  maxUploadBytes: 25 * 1024 * 1024,
  /** Files on one record. Without it, one record is an unbounded bucket. */
  maxPerRecord: 50,
  /** Longest filename we store. Display only; truncated again at download. */
  maxFileNameChars: 255,
  /**
   * How long a deleted attachment's bytes are kept before the worker removes
   * them. Matches the 30-day Recycle Bin: an undelete that cannot bring the
   * file back is not an undelete.
   */
  purgeAfterDays: 30,
} as const;

/** How much of the file the byte check needs. */
export const ATTACHMENT_PREFIX_LENGTH = 8192;

/** The formats an attachment may be. `text` is the negative case. */
export type AttachmentFormat =
  Extract<KnownFileFormat, 'zip' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp'> | 'text';

export interface AllowedAttachmentType {
  readonly extension: string;
  /** The type the server binds the upload to and serves the download as. */
  readonly mime: string;
  /** What the bytes must look like for the name to be believed. */
  readonly format: AttachmentFormat;
}

/**
 * The allow-list. Everything not here is refused by extension before a byte is
 * uploaded, which is the cheapest place to refuse anything.
 *
 * The OOXML entries and `zip` all expect `format: 'zip'`, because that is the
 * honest limit of a signature check on them: `PK\x03\x04` says "a zip archive"
 * and nothing more. We never open an attachment archive, so a bomb inside one
 * costs storage and nothing else — unlike an import, which must inflate it.
 */
export const ALLOWED_ATTACHMENT_TYPES: readonly AllowedAttachmentType[] = [
  { extension: 'pdf', mime: 'application/pdf', format: 'pdf' },
  { extension: 'png', mime: 'image/png', format: 'png' },
  { extension: 'jpg', mime: 'image/jpeg', format: 'jpeg' },
  { extension: 'jpeg', mime: 'image/jpeg', format: 'jpeg' },
  { extension: 'gif', mime: 'image/gif', format: 'gif' },
  { extension: 'webp', mime: 'image/webp', format: 'webp' },
  { extension: 'txt', mime: 'text/plain', format: 'text' },
  { extension: 'csv', mime: 'text/csv', format: 'text' },
  { extension: 'zip', mime: 'application/zip', format: 'zip' },
  {
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    format: 'zip',
  },
  {
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    format: 'zip',
  },
  {
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    format: 'zip',
  },
];

const BY_EXTENSION: ReadonlyMap<string, AllowedAttachmentType> = new Map(
  ALLOWED_ATTACHMENT_TYPES.map((entry) => [entry.extension, entry]),
);

/** The extensions the UI offers and the contract accepts, for messages. */
export const ALLOWED_ATTACHMENT_EXTENSIONS: readonly string[] = ALLOWED_ATTACHMENT_TYPES.map(
  (entry) => entry.extension,
);

/**
 * Characters a filename may never contain, whatever else it says.
 *
 * Separators and traversal because a name must never be able to read as a
 * path — it is not one, it is never part of a storage key, and a name that
 * *looks* like one invites some future caller to treat it as one. Control
 * characters because the name ends up in a header. The bidirectional overrides
 * because `invoice‮gnp.exe` renders as `invoice exe.png`: the user is
 * shown one file and saves another, which is the whole attack.
 */
const BIDI_OVERRIDES = /[‪-‮⁦-⁩‎‏]/u;
// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type FileNameProblem =
  | 'empty'
  | 'too_long'
  | 'path_separator'
  | 'traversal'
  | 'control_character'
  | 'bidi_override'
  | 'extension_not_allowed';

/**
 * Why this filename is not acceptable, or `null` when it is.
 *
 * Deliberately a rejection rather than a quiet repair: a name we silently
 * rewrote is a name the uploader cannot recognise in the list afterwards, and
 * "we fixed it" is how a hostile name survives into the one caller that forgot
 * to ask. `safeDownloadName` still sanitises on the way out, because two
 * independent controls on the one string that reaches a header is the point.
 */
export function attachmentFileNameProblem(name: string): FileNameProblem | null {
  if (name.trim().length === 0) return 'empty';
  if ([...name].length > ATTACHMENT_LIMITS.maxFileNameChars) return 'too_long';
  if (/[\\/]/.test(name)) return 'path_separator';
  // `..` anywhere, and the two names that are themselves path components.
  if (name.includes('..') || name === '.') return 'traversal';
  if (CONTROL_CHARACTERS.test(name)) return 'control_character';
  if (BIDI_OVERRIDES.test(name)) return 'bidi_override';
  if (attachmentTypeFor(name) === null) return 'extension_not_allowed';
  return null;
}

/** The extension, lower-cased, with no dot. Empty when there is none. */
export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The allow-list entry a filename claims, or `null` when it claims nothing we
 * accept. This is where `report.pdf.exe` is refused: the claim is the **last**
 * extension, which is also the one the operating system obeys.
 */
export function attachmentTypeFor(name: string): AllowedAttachmentType | null {
  return BY_EXTENSION.get(attachmentExtension(name)) ?? null;
}

/**
 * The content type the server binds an upload to, and serves a download as.
 *
 * Never the client's `Content-Type` and never the sniffed type echoed back:
 * both are strings an attacker chose. This comes from our own closed list,
 * which is why `text/html` cannot come out of it.
 */
export function attachmentContentType(name: string): string | null {
  return attachmentTypeFor(name)?.mime ?? null;
}

export type AttachmentDetection =
  | { readonly ok: true; readonly format: AttachmentFormat }
  | { readonly ok: false; readonly reason: string };

/**
 * What the bytes say, regardless of the name.
 *
 * Unlike the import detector this one has a positive allow-list to satisfy, so
 * an unrecognised binary is refused as "not a type we accept" rather than
 * named — there is nothing useful to tell the user about a format we would
 * never store anyway.
 */
export function detectAttachmentFormat(prefix: Uint8Array): AttachmentDetection {
  if (prefix.length === 0) return { ok: false, reason: 'The file is empty' };

  const signature = matchFileSignature(prefix);
  if (signature !== null) {
    if (isAttachmentFormat(signature.format)) return { ok: true, format: signature.format };
    return { ok: false, reason: `The file is ${signature.label}, which cannot be attached` };
  }

  const body = startsWith(prefix, UTF8_BOM) ? prefix.subarray(UTF8_BOM.length) : prefix;
  const problem = textProblem(body);
  if (problem !== null) {
    return { ok: false, reason: `The file is not a type that can be attached: ${problem}` };
  }
  return { ok: true, format: 'text' };
}

function isAttachmentFormat(format: KnownFileFormat): format is AttachmentFormat & KnownFileFormat {
  return (
    format === 'zip' ||
    format === 'pdf' ||
    format === 'png' ||
    format === 'jpeg' ||
    format === 'gif' ||
    format === 'webp'
  );
}

/**
 * Compare what the name claimed with what the bytes are.
 *
 * A disagreement is the signal, exactly as it is for an import: a `.png` whose
 * bytes are a zip is not "probably fine", it is someone trying something.
 * Returns a sentence for the user, or `null` when they agree.
 */
export function attachmentFormatMismatch(
  fileName: string,
  detected: AttachmentFormat,
): string | null {
  const claimed = attachmentTypeFor(fileName);
  if (claimed === null) return 'The file name does not have an extension we accept';
  if (claimed.format === detected) return null;
  return `The file is named .${claimed.extension} but its contents are not`;
}
