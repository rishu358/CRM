/**
 * File type by content, never by name (CLAUDE.md §5.12).
 *
 * The filename and the `Content-Type` are both things the uploader typed. A
 * file called `customers.csv` can be an executable, a PDF, or a zip bomb; the
 * only honest evidence is the bytes.
 *
 * The evidence itself — the signature table and the "is this plausibly text?"
 * test — lives in `../files/signatures.js` and is shared with record
 * attachments (ADR-0035), which ask the same question against a different
 * allow-list. What is left here is the import's own answer: **only** a CSV or
 * a workbook is acceptable, so every other recognised format is refused by
 * name, and anything unrecognised must look like text.
 *
 * What a CSV *is* has no signature — it is text with commas — so "CSV" here
 * means "not recognisably anything else, and plausibly text". That is a
 * negative test and is honest about being one.
 */

import {
  matchFileSignature,
  startsWith,
  textProblem,
  UTF16_BE_BOM,
  UTF16_LE_BOM,
  UTF8_BOM,
} from '../files/signatures.js';

export type DetectedFormat = 'xlsx_candidate' | 'csv';

export type DetectionResult =
  | { readonly ok: true; readonly format: DetectedFormat }
  | { readonly ok: false; readonly reason: string };

/** How much of the file the detector needs. */
export const MAGIC_BYTES_PREFIX_LENGTH = 8192;

/**
 * Decide what a file is from its first bytes.
 *
 * `xlsx_candidate` is only a candidate: a zip signature says "zip", and the
 * caller must still open the archive and confirm it holds a workbook
 * (`inspectXlsxArchive`). Everything this function says about a file is
 * "it could be", never "it is".
 */
export function detectUploadFormat(prefix: Uint8Array): DetectionResult {
  if (prefix.length === 0) return { ok: false, reason: 'The file is empty' };

  const signature = matchFileSignature(prefix);
  if (signature !== null) {
    // An .xlsx is a zip; so is a .jar, a .docx and a bomb.
    if (signature.format === 'zip') return { ok: true, format: 'xlsx_candidate' };
    return {
      ok: false,
      reason: `The file is ${signature.label}, not a CSV or XLSX workbook`,
    };
  }

  if (startsWith(prefix, UTF16_LE_BOM) || startsWith(prefix, UTF16_BE_BOM)) {
    return { ok: false, reason: 'UTF-16 files are not supported; save the CSV as UTF-8' };
  }

  const body = startsWith(prefix, UTF8_BOM) ? prefix.subarray(UTF8_BOM.length) : prefix;
  const problem = textProblem(body);
  if (problem !== null) {
    return { ok: false, reason: `The file is not a CSV: ${problem}` };
  }
  return { ok: true, format: 'csv' };
}

/**
 * The format the uploader *claimed*, from the filename. Advisory only: it is
 * compared against `detectUploadFormat`, and a disagreement rejects the file.
 */
export type ClaimedFormat = 'csv' | 'xlsx';

export function claimedFormatFromFileName(fileName: string): ClaimedFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

/**
 * Compare what the uploader said with what the bytes say.
 *
 * A `.csv` whose bytes are a zip is rejected, and so is an `.xlsx` that is
 * plain text. Neither is "probably fine": the mismatch is itself the signal,
 * and the cheap response is to refuse. Returns a reason, or `null` when they
 * agree.
 */
export function formatMismatch(claimed: ClaimedFormat, detected: DetectedFormat): string | null {
  const detectedAs = detected === 'xlsx_candidate' ? 'xlsx' : 'csv';
  if (claimed === detectedAs) return null;
  return claimed === 'csv'
    ? 'The file is named .csv but its contents are a zip archive'
    : 'The file is named .xlsx but its contents are plain text';
}
