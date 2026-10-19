/**
 * Hard limits on what an import will accept (CLAUDE.md §5.12).
 *
 * An import is the one path that turns a file a user supplies into rows in
 * bulk, so every dimension of that file needs a ceiling *before* it costs
 * anything: bytes on the wire, bytes after decompression, rows, columns, the
 * length of one cell. Each limit answers a specific attack, named beside it,
 * because a limit nobody can justify is a limit somebody raises "just this
 * once" when a customer complains.
 *
 * They are constants, not tenant settings. A plan may one day buy a higher
 * row ceiling; it never buys a way past the decompression ceiling.
 */
export const IMPORT_LIMITS = {
  /** What a presigned upload may carry. A 100k-row contact CSV is ~15 MB. */
  maxUploadBytes: 25 * 1024 * 1024,
  /** Rows of data, excluding the header. Above the 50,000 MVP_SPEC §M8 asks for. */
  maxRows: 100_000,
  /** "A sheet with a million columns": XLSX allows 16,384, CSV allows anything. */
  maxColumns: 200,
  /** Longest single cell. Matches the `long_text` field ceiling. */
  maxCellChars: 32_000,
  /** One column header. A header is a label, not a payload. */
  maxHeaderChars: 200,
  /** Zip bomb: how many entries a workbook may declare. A real one has ~12. */
  maxZipEntries: 100,
  /** Zip bomb: total bytes after inflating every entry, counted, not declared. */
  maxInflatedBytes: 200 * 1024 * 1024,
  /** Zip bomb: an entry this large must also stay under `maxInflateRatio`. */
  ratioCheckFloorBytes: 1024 * 1024,
  /** Real sheet XML inflates ~10-20x. A bomb is 1000x and up. */
  maxInflateRatio: 100,
  /** Rows written per transaction. Also the unit of idempotency (ADR-0029). */
  chunkRows: 500,
  /** Errors recorded in detail before we only count. Keeps the error file bounded. */
  maxRecordedErrors: 10_000,
  /** Rows shown in the mapping preview. */
  previewRows: 10,
} as const;

export const EXPORT_LIMITS = {
  /** Rows one export may contain. Beyond this the answer is "narrow the filter". */
  maxRows: 1_000_000,
  /** Keyset page size when streaming rows out. */
  pageRows: 1_000,
} as const;

/** How long a presigned URL lives (CLAUDE.md §5.12: "short-lived"). */
export const PRESIGNED_URL_TTL_SECONDS = {
  upload: 10 * 60,
  download: 5 * 60,
} as const;

/** How long a finished export or error file is kept before the sweep removes it. */
export const GENERATED_FILE_RETENTION_HOURS = 24;
