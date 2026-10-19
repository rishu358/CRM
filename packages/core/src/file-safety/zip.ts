import { createInflateRaw } from 'node:zlib';
import { IMPORT_LIMITS } from '../import-export/limits.js';

/**
 * Open an .xlsx archive far enough to know it is safe to hand to a parser
 * (CLAUDE.md §5.12).
 *
 * An .xlsx is a zip, and a zip is the classic decompression bomb: a few
 * kilobytes that inflate to gigabytes, so that a parser which trusts the
 * archive exhausts the worker's memory before it has read one cell. The
 * defence has to run **before** the real parser and has to measure rather than
 * believe, because every size in a zip header is something the author wrote.
 *
 * So this does its own bounded pass:
 *
 *   1. read the central directory and refuse on entry count, encryption,
 *      zip64, odd names, and a missing workbook part;
 *   2. inflate every entry through a counter that aborts the moment the
 *      running total passes the ceiling — counting real output, not the
 *      declared size;
 *   3. refuse when the declared size and the real size disagree, or when an
 *      entry's real ratio is bomb-shaped.
 *
 * It costs a second decompression of a file capped at `maxUploadBytes`, which
 * is cheap next to the thing it prevents. The input is a `Buffer` because the
 * worker has already bounded the object's size with `head()`.
 */

export class UnsafeArchiveError extends Error {
  /**
   * How many bytes had actually been inflated when the archive was refused, when
   * it was refused for expanding too far.
   *
   * It exists so that "stops at the budget instead of inflating the whole bomb"
   * is something a test can assert directly. The alternative, asserting that it
   * finished within some number of seconds, measures the machine rather than the
   * code and fails on a loaded CI runner.
   */
  readonly inflatedBytes: number | undefined;

  constructor(message: string, options: { inflatedBytes?: number } = {}) {
    super(message);
    this.name = 'UnsafeArchiveError';
    this.inflatedBytes = options.inflatedBytes;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ArchiveEntry {
  readonly name: string;
  readonly crc32: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly declaredSize: number;
  readonly method: number;
  readonly localHeaderOffset: number;
}

export interface ArchiveReport {
  readonly entryCount: number;
  readonly inflatedBytes: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = buffer.length - EOCD_MIN_LENGTH; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new UnsafeArchiveError('The workbook is not a valid zip archive');
}

function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  return !name.split('/').includes('..');
}

export function readCentralDirectory(buffer: Buffer): ArchiveEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  // 0xFFFF / 0xFFFFFFFF mean "see the zip64 record". No real workbook needs it
  // and an archive that does is not one we want to be parsing.
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new UnsafeArchiveError('Zip64 archives are not supported');
  }
  if (totalEntries > IMPORT_LIMITS.maxZipEntries) {
    throw new UnsafeArchiveError(
      `The workbook has ${totalEntries} parts; the limit is ${IMPORT_LIMITS.maxZipEntries}`,
    );
  }
  if (directoryOffset + directorySize > eocd) {
    throw new UnsafeArchiveError('The workbook is not a valid zip archive');
  }

  const entries: ArchiveEntry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new UnsafeArchiveError('The workbook is not a valid zip archive');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const declaredSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if ((flags & 0x1) !== 0) throw new UnsafeArchiveError('Encrypted workbooks are not supported');
    if (!isSafeEntryName(name))
      throw new UnsafeArchiveError('The workbook has an unsafe part name');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new UnsafeArchiveError('The workbook uses an unsupported compression method');
    }

    entries.push({ name, crc32, flags, compressedSize, declaredSize, method, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Inflate one entry's data, counting real output and stopping at `budget` bytes. */
function countInflated(data: Buffer, budget: number, alreadyInflated: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let total = 0;

    inflate.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > budget) {
        inflate.destroy();
        reject(
          new UnsafeArchiveError('The workbook expands to more data than is allowed', {
            inflatedBytes: alreadyInflated + total,
          }),
        );
      }
    });
    inflate.on('end', () => resolve(total));
    inflate.on('error', () => reject(new UnsafeArchiveError('The workbook is corrupt')));
    inflate.end(data);
  });
}

/**
 * Confirm an archive is a workbook and cannot hurt the worker.
 *
 * Throws `UnsafeArchiveError` with a message that is safe to show the user.
 */
export async function inspectXlsxArchive(buffer: Buffer): Promise<ArchiveReport> {
  const entries = readCentralDirectory(buffer);

  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new UnsafeArchiveError('The file is a zip archive but not an Excel workbook');
  }

  let inflatedBytes = 0;

  for (const entry of entries) {
    const header = entry.localHeaderOffset;
    if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
      throw new UnsafeArchiveError('The workbook is not a valid zip archive');
    }
    const nameLength = buffer.readUInt16LE(header + 26);
    const extraLength = buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > buffer.length)
      throw new UnsafeArchiveError('The workbook is not a valid zip archive');

    const data = buffer.subarray(start, end);
    const budget = IMPORT_LIMITS.maxInflatedBytes - inflatedBytes;
    const actual =
      entry.method === METHOD_STORED
        ? data.length
        : await countInflated(data, budget, inflatedBytes);

    if (actual !== entry.declaredSize) {
      // The header lied. Whichever way it lied, a parser that trusts the
      // header is now making decisions on a number the author chose.
      throw new UnsafeArchiveError('The workbook is corrupt: part sizes do not match');
    }
    if (
      actual > IMPORT_LIMITS.ratioCheckFloorBytes &&
      actual / Math.max(entry.compressedSize, 1) > IMPORT_LIMITS.maxInflateRatio
    ) {
      throw new UnsafeArchiveError('The workbook expands to more data than is allowed');
    }

    inflatedBytes += actual;
    if (inflatedBytes > IMPORT_LIMITS.maxInflatedBytes) {
      throw new UnsafeArchiveError('The workbook expands to more data than is allowed');
    }
  }

  return { entryCount: entries.length, inflatedBytes };
}

/**
 * Where an entry should sit for a *streaming* reader to cope with it.
 *
 * A streaming xlsx parser handles each entry as it arrives, so it needs the
 * workbook's own description (`workbook.xml`, its relationships) and the lookup
 * tables the sheets point into (shared strings, styles) **before** the sheets
 * themselves. The zip format does not promise that order and real writers
 * disagree: Excel, LibreOffice, Google Sheets and ExcelJS each pick their own,
 * and ExcelJS's choice even varies between runs. A parser that assumes one
 * order rejects files that are perfectly valid, which to a user is a customer
 * list that "will not import" for no reason they can see.
 *
 * Lower sorts first. Sheets last; everything not named in the middle.
 */
export function streamingRank(name: string): number {
  if (name === '[Content_Types].xml') return 0;
  if (name === '_rels/.rels') return 1;
  if (name === 'xl/_rels/workbook.xml.rels') return 2;
  if (name === 'xl/workbook.xml') return 3;
  if (name === 'xl/sharedStrings.xml') return 4;
  if (name === 'xl/styles.xml') return 5;
  if (name.startsWith('xl/worksheets/')) return 20;
  return 10;
}

/**
 * Rewrite an archive with its entries in a chosen order, **without
 * recompressing anything**.
 *
 * The compressed bytes of each entry are copied as they are; only the headers
 * are rewritten, so this costs a memcpy and cannot change what any entry
 * contains. It also normalises what the headers say — real sizes in the local
 * header, no data-descriptor flag, no extra fields — which removes a second
 * class of surprises for the parser downstream.
 *
 * Call it only on an archive `inspectXlsxArchive` has accepted: it trusts the
 * central directory it is given, and that is what inspection validated.
 */
export function reorderArchive(
  buffer: Buffer,
  rank: (name: string) => number = streamingRank,
): Buffer {
  const entries = readCentralDirectory(buffer)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.name) - rank(b.entry.name) || a.index - b.index)
    .map(({ entry }) => entry);

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const header = entry.localHeaderOffset;
    const nameLength = buffer.readUInt16LE(header + 26);
    const extraLength = buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + entry.compressedSize);
    const name = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8, nothing else
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}
