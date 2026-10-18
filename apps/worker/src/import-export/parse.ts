import {
  detectUploadFormat,
  formatMismatch,
  IMPORT_LIMITS,
  MAGIC_BYTES_PREFIX_LENGTH,
  unescapeSpreadsheetCell,
  type ClaimedFormat,
  type StorageProvider,
} from '@crm/core';
import { inspectXlsxArchive, reorderArchive, UnsafeArchiveError } from '@crm/core/file-safety';
import { parse as parseCsv, CsvError } from 'csv-parse';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

/**
 * Open an uploaded file safely and read it as rows (CLAUDE.md §5.12).
 *
 * This is the only code in the repository that reads the bytes of a file a
 * user supplied, so it is where every ceiling is enforced, in the order they
 * are cheapest to check:
 *
 *   1. size, from the object store's metadata and again while reading
 *   2. type, from magic bytes, compared with what the filename claimed
 *   3. for a workbook, the archive itself: entry count, real inflated size,
 *      ratio, names (`inspectXlsxArchive`)
 *   4. while parsing: rows, columns, cell length, and wall-clock time
 *
 * Every failure is an `UploadRejected` whose message is safe to show the user.
 * A file that fails never becomes a stack trace, and never leaves the worker
 * holding memory for more than the limits allow.
 *
 * **It is called twice for the same file**, once to analyze and once to stage,
 * and both calls run all of it. That is deliberate: a presigned PUT stays valid
 * for minutes, so between analysis and staging the uploader could replace the
 * object with a different one of the same size. If only the first call
 * validated, the second would be parsing an unchecked file. Validating on every
 * read means there is no window.
 */

export class UploadRejected extends Error {
  /**
   * `cause` is the underlying parser error, for the worker's log. It is never
   * shown to the user (`message` is) and never contains a cell value: it is the
   * library's own diagnostic about the container, not about the data.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UploadRejected';
  }
}

/** A parse that has taken this long is not going to finish usefully. */
export const PARSE_TIME_BUDGET_MS = 120_000;

export interface SourceRow {
  /** 1 is the header; the first data row is 2. What the user sees in their file. */
  readonly sourceRow: number;
  readonly cells: string[];
}

export interface OpenedUpload {
  readonly format: ClaimedFormat;
  /** Every row after the header's, blanks skipped, limits enforced as it goes. */
  readonly header: string[];
  readonly rows: AsyncGenerator<SourceRow>;
}

export interface UploadDescriptor {
  readonly storageKey: string;
  readonly claimedFormat: ClaimedFormat;
  readonly declaredSize: number | null;
}

/** Collect an object's bytes, refusing to read past the ceiling. */
async function readBounded(storage: StorageProvider, key: string): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of storage.openRead(key)) {
    total += part.length;
    if (total > IMPORT_LIMITS.maxUploadBytes) {
      throw new UploadRejected('The file is larger than the upload limit');
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function* boundedStream(storage: StorageProvider, key: string): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const part of storage.openRead(key)) {
    total += part.length;
    if (total > IMPORT_LIMITS.maxUploadBytes) {
      throw new UploadRejected('The file is larger than the upload limit');
    }
    yield part;
  }
}

/** Pick the delimiter from the first line, outside quotes. Excel exports `;` in many locales. */
function sniffDelimiter(prefix: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(prefix).replace(/^\uFEFF/, '');
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
    ['|', 0],
  ]);
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    else if (!inQuotes && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** What a spreadsheet cell holds, as the text a person would read. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    const iso = value.toISOString();
    // A date-only cell arrives as midnight UTC; keep it a plain date.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // A formula cell: the *result* is data, the formula text never is. Importing
    // a workbook must not carry a formula into a record.
    if ('result' in object) return cellToString(object['result']);
    if ('formula' in object || 'sharedFormula' in object) return '';
    if (Array.isArray(object['richText'])) {
      return (object['richText'] as { text?: unknown }[])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    if (typeof object['text'] === 'string') return object['text'];
    if ('error' in object) return '';
  }
  return '';
}

function checkRow(cells: string[], rowLabel: number): string[] {
  if (cells.length > IMPORT_LIMITS.maxColumns) {
    throw new UploadRejected(
      `The file has more than ${IMPORT_LIMITS.maxColumns} columns (row ${rowLabel})`,
    );
  }
  for (const cell of cells) {
    if (cell.length > IMPORT_LIMITS.maxCellChars) {
      throw new UploadRejected(
        `A cell in row ${rowLabel} is longer than ${IMPORT_LIMITS.maxCellChars} characters`,
      );
    }
  }
  return cells.map(unescapeSpreadsheetCell);
}

function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

/**
 * Validate the upload and open it for reading.
 *
 * Does everything up to, but not including, reading rows; the rows come from
 * the returned generator, which keeps enforcing limits until it is exhausted or
 * abandoned. The generator is safe to abandon early (the analyze step reads
 * only as far as it must), and closing it releases the underlying stream.
 */
export async function openUpload(
  storage: StorageProvider,
  upload: UploadDescriptor,
): Promise<OpenedUpload> {
  const stored = await storage.head(upload.storageKey);
  if (stored === null) throw new UploadRejected('The uploaded file could not be found');
  if (stored.sizeBytes > IMPORT_LIMITS.maxUploadBytes) {
    throw new UploadRejected('The file is larger than the upload limit');
  }
  if (upload.declaredSize !== null && stored.sizeBytes !== upload.declaredSize) {
    throw new UploadRejected('The uploaded file is not the size that was declared');
  }

  const prefix = await storage.readPrefix(upload.storageKey, MAGIC_BYTES_PREFIX_LENGTH);
  const detected = detectUploadFormat(prefix);
  if (!detected.ok) throw new UploadRejected(detected.reason);

  const mismatch = formatMismatch(upload.claimedFormat, detected.format);
  if (mismatch !== null) throw new UploadRejected(mismatch);

  const deadline = Date.now() + PARSE_TIME_BUDGET_MS;

  if (detected.format === 'csv') return openCsv(storage, upload, prefix, deadline);
  return openXlsx(storage, upload, deadline);
}

async function openCsv(
  storage: StorageProvider,
  upload: UploadDescriptor,
  prefix: Uint8Array,
  deadline: number,
): Promise<OpenedUpload> {
  const parser = parseCsv({
    delimiter: sniffDelimiter(prefix),
    bom: true,
    // Real-world files have ragged rows; the *limits* below are the guard, not
    // strict arity. A short row simply has blank trailing cells.
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: IMPORT_LIMITS.maxColumns * IMPORT_LIMITS.maxCellChars,
    info: true,
  });

  const source = Readable.from(boundedStream(storage, upload.storageKey));
  source.on('error', (error) => parser.destroy(error));
  source.pipe(parser);

  const iterator = parser[Symbol.asyncIterator]() as AsyncIterator<{
    record: string[];
    info: { lines: number };
  }>;

  async function next(): Promise<SourceRow | null> {
    if (Date.now() > deadline) throw new UploadRejected('The file took too long to read');
    try {
      const result = await iterator.next();
      if (result.done) return null;
      const { record, info } = result.value;
      return { sourceRow: info.lines, cells: checkRow(record, info.lines) };
    } catch (error) {
      throw translateCsvError(error);
    }
  }

  function dispose(): Promise<void> {
    parser.destroy();
    source.destroy();
    return Promise.resolve();
  }

  let header: string[] | null = null;
  while (header === null) {
    const row = await next();
    if (row === null) {
      await dispose();
      throw new UploadRejected('The file has no rows');
    }
    if (!isBlankRow(row.cells)) header = row.cells;
  }

  return { format: 'csv', header, rows: rowsOf(next, dispose) };
}

function translateCsvError(error: unknown): Error {
  if (error instanceof UploadRejected) return error;
  if (error instanceof CsvError) {
    // The code names the kind of problem and never contains file content.
    return new UploadRejected(`The CSV could not be parsed (${error.code ?? 'malformed'})`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function openXlsx(
  storage: StorageProvider,
  upload: UploadDescriptor,
  deadline: number,
): Promise<OpenedUpload> {
  const buffer = await readBounded(storage, upload.storageKey);

  try {
    await inspectXlsxArchive(buffer);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw new UploadRejected(error.message);
    throw error;
  }

  // Re-ordered so the streaming reader sees the workbook description before the
  // sheets, whichever order the writer chose (`streamingRank`). Safe because the
  // archive has just been inspected; the entries' bytes are copied, not changed.
  const ordered = reorderArchive(buffer);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([ordered]), {
    // Shared strings are cached so cell text can be resolved while streaming;
    // everything we do not need (styles, hyperlinks) is skipped so the reader
    // does no work on it. Styles are the exception: they are what tells a date
    // cell from a number, and a date imported as 46023 is a corrupted record.
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'cache',
    worksheets: 'emit',
    entries: 'ignore',
  });

  async function* allRows(): AsyncGenerator<SourceRow> {
    try {
      for await (const worksheet of reader) {
        // The first worksheet only. A workbook with several is common; which one
        // the user meant is not something to guess, and the first is the one
        // Excel shows on open.
        for await (const row of worksheet as AsyncIterable<ExcelJS.Row>) {
          if (Date.now() > deadline) throw new UploadRejected('The file took too long to read');
          const values = row.values as unknown[];
          // `values` is 1-indexed with an empty slot 0.
          const cells: string[] = [];
          for (let index = 1; index < values.length; index += 1) {
            cells.push(cellToString(values[index]));
          }
          // A cell at column XFD makes a 16,384-wide array, so this must be
          // checked before anything is kept.
          yield { sourceRow: row.number, cells: checkRow(cells, row.number) };
        }
        return;
      }
    } catch (error) {
      if (error instanceof UploadRejected) throw error;
      throw new UploadRejected('The workbook could not be read', { cause: error });
    }
  }

  const generator = allRows();
  async function next(): Promise<SourceRow | null> {
    const result = await generator.next();
    return result.done === true ? null : result.value;
  }
  async function dispose(): Promise<void> {
    await generator.return(undefined);
  }

  let header: string[] | null = null;
  while (header === null) {
    const row = await next();
    if (row === null) {
      await dispose();
      throw new UploadRejected('The file has no rows');
    }
    if (!isBlankRow(row.cells)) header = row.cells;
  }

  return { format: 'xlsx', header, rows: rowsOf(next, dispose) };
}

/** Data rows: blanks skipped, the row ceiling enforced as they are read. */
async function* rowsOf(
  next: () => Promise<SourceRow | null>,
  dispose: () => Promise<void>,
): AsyncGenerator<SourceRow> {
  let count = 0;
  try {
    for (;;) {
      const row = await next();
      if (row === null) return;
      if (isBlankRow(row.cells)) continue;
      count += 1;
      if (count > IMPORT_LIMITS.maxRows) {
        throw new UploadRejected(`The file has more than ${IMPORT_LIMITS.maxRows} rows`);
      }
      yield row;
    }
  } finally {
    await dispose();
  }
}
