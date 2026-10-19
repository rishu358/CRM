/**
 * File type by content, never by name (CLAUDE.md §5.12).
 *
 * The filename and the `Content-Type` are both things the uploader typed. A
 * file called `customers.csv` can be an executable, a PDF, or a zip bomb; the
 * only honest evidence is the bytes. This file is deliberately small and
 * dependency-free: it is a security control, and a control that is a library
 * call is a control whose behaviour changes when somebody bumps a version.
 *
 * What a CSV *is* has no signature — it is text with commas — so "CSV" here
 * means "not recognisably anything else, and plausibly text": no NUL bytes, no
 * stray control characters, valid UTF-8, and none of the signatures below.
 * That is a negative test and is honest about being one.
 */

export type DetectedFormat = 'xlsx_candidate' | 'csv';

export type DetectionResult =
  | { readonly ok: true; readonly format: DetectedFormat }
  | { readonly ok: false; readonly reason: string };

/** Signatures of formats that are never a CSV or a workbook, however they are named. */
const FORBIDDEN_SIGNATURES: readonly {
  readonly name: string;
  readonly bytes: readonly number[];
}[] = [
  { name: 'a PDF', bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: 'a Windows executable', bytes: [0x4d, 0x5a] },
  { name: 'an ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'a Mach-O executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'a Mach-O executable', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'a PNG image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'a JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'a GIF image', bytes: [0x47, 0x49, 0x46, 0x38] },
  // Legacy .xls and .doc. Not supported; saying so beats a parse error.
  { name: 'a legacy Office (.xls/.doc) file', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { name: 'a gzip archive', bytes: [0x1f, 0x8b] },
  { name: 'a 7-Zip archive', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { name: 'a RAR archive', bytes: [0x52, 0x61, 0x72, 0x21] },
  { name: 'a shell script', bytes: [0x23, 0x21] },
];

/** `PK\x03\x04`: a zip. An .xlsx is one; so is a .jar, a .docx and a bomb. */
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16_LE_BOM = [0xff, 0xfe] as const;
const UTF16_BE_BOM = [0xfe, 0xff] as const;

/** How much of the file the detector needs. */
export const MAGIC_BYTES_PREFIX_LENGTH = 8192;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/**
 * Drop an incomplete multi-byte sequence from the end of a prefix.
 *
 * The prefix is a slice of a longer file, so it can end in the middle of a
 * character. Without this a perfectly good UTF-8 file whose 8192nd byte lands
 * inside "é" would be rejected as invalid.
 */
function trimPartialUtf8Tail(bytes: Uint8Array): Uint8Array {
  const maxBack = Math.min(3, bytes.length);
  for (let back = 1; back <= maxBack; back += 1) {
    const byte = bytes[bytes.length - back];
    if (byte === undefined) break;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation byte, keep looking
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

function textProblem(prefix: Uint8Array): string | null {
  for (const byte of prefix) {
    if (byte === 0x00) return 'it contains NUL bytes, which text never does';
    // Control characters other than tab, line feed and carriage return.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return 'it contains binary control characters';
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8Tail(prefix));
  } catch {
    return 'it is not valid UTF-8 text';
  }
  return null;
}

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

  if (startsWith(prefix, ZIP_LOCAL_HEADER)) return { ok: true, format: 'xlsx_candidate' };

  for (const signature of FORBIDDEN_SIGNATURES) {
    if (startsWith(prefix, signature.bytes)) {
      return { ok: false, reason: `The file is ${signature.name}, not a CSV or XLSX workbook` };
    }
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
