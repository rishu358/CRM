/**
 * One table of file signatures, shared by everything that asks "what is this
 * file really?" (CLAUDE.md §5.12).
 *
 * There were two questions and there is one table. Import asks "is this a CSV
 * or a workbook, and does that match the name?"; an attachment asks "is this
 * one of the types we accept, and does that match the name?". The allow-lists
 * differ — an import refuses a PDF by name, an attachment welcomes one — but
 * the evidence is identical, and keeping the evidence in one place means a
 * signature added for one caller is known to the other.
 *
 * Dependency-free on purpose, like the detector it grew out of: a security
 * control that is a library call is a control whose behaviour changes when
 * somebody bumps a version.
 *
 * **Two-byte ASCII signatures are a trap.** `MZ` (0x4d 0x5a) is a Windows
 * executable and also the first two characters of a CSV whose first cell is
 * `MZ...`; `BM` is a bitmap and also `BMW`. The one such signature here is the
 * executable, which predates this table and is worth its false positives
 * because the cost of missing it is so much higher. Nothing else two bytes
 * long and printable belongs in this list.
 */

/** A format a signature can establish. `text` has none and is inferred. */
export type KnownFileFormat =
  | 'zip'
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'gzip'
  | 'sevenzip'
  | 'rar'
  | 'pe'
  | 'elf'
  | 'macho'
  | 'ole2'
  | 'shebang';

export interface FileSignature {
  readonly format: KnownFileFormat;
  /** How a message names it to a user: "The file is **a PDF**". */
  readonly label: string;
  readonly bytes: readonly number[];
  /** A second run of bytes further in, for containers like RIFF/WEBP. */
  readonly then?: { readonly offset: number; readonly bytes: readonly number[] };
}

/**
 * Ordered, most specific first.
 *
 * `zip` leads because every OOXML document, every `.jar` and every zip bomb is
 * one, and callers need to recognise that before anything else; the rest are in
 * no significant order because no two of them can match the same prefix.
 */
export const FILE_SIGNATURES: readonly FileSignature[] = [
  /** `PK\x03\x04`: a zip. An .xlsx is one; so is a .jar, a .docx and a bomb. */
  { format: 'zip', label: 'a zip archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'pdf', label: 'a PDF', bytes: [0x25, 0x50, 0x44, 0x46] },
  { format: 'png', label: 'a PNG image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: 'jpeg', label: 'a JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { format: 'gif', label: 'a GIF image', bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    format: 'webp',
    label: 'a WebP image',
    bytes: [0x52, 0x49, 0x46, 0x46],
    then: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
  { format: 'pe', label: 'a Windows executable', bytes: [0x4d, 0x5a] },
  { format: 'elf', label: 'an ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { format: 'macho', label: 'a Mach-O executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { format: 'macho', label: 'a Mach-O executable', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  // Legacy .xls and .doc. Not supported; saying so beats a parse error.
  { format: 'ole2', label: 'a legacy Office (.xls/.doc) file', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { format: 'gzip', label: 'a gzip archive', bytes: [0x1f, 0x8b] },
  { format: 'sevenzip', label: 'a 7-Zip archive', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { format: 'rar', label: 'a RAR archive', bytes: [0x52, 0x61, 0x72, 0x21] },
  { format: 'shebang', label: 'a shell script', bytes: [0x23, 0x21] },
];

export const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
export const UTF16_LE_BOM = [0xff, 0xfe] as const;
export const UTF16_BE_BOM = [0xfe, 0xff] as const;

export function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** The first signature the prefix matches, or `null` when none does. */
export function matchFileSignature(prefix: Uint8Array): FileSignature | null {
  for (const signature of FILE_SIGNATURES) {
    if (!startsWith(prefix, signature.bytes)) continue;
    if (
      signature.then !== undefined &&
      !startsWith(prefix, signature.then.bytes, signature.then.offset)
    ) {
      continue;
    }
    return signature;
  }
  return null;
}

/**
 * Drop an incomplete multi-byte sequence from the end of a prefix.
 *
 * The prefix is a slice of a longer file, so it can end in the middle of a
 * character. Without this a perfectly good UTF-8 file whose last byte lands
 * inside "é" would be rejected as invalid.
 */
export function trimPartialUtf8Tail(bytes: Uint8Array): Uint8Array {
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

/**
 * Why this prefix is not plausibly text, or `null` when it is.
 *
 * "Text" has no signature, so this is a negative test and is honest about
 * being one: no NUL bytes, no stray control characters, valid UTF-8. It stops
 * an executable or an image wearing a `.txt`; it cannot tell a shopping list
 * from a ransom note, and does not try to.
 */
export function textProblem(prefix: Uint8Array): string | null {
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
