import { IMPORT_LIMITS } from '@crm/core';
import { reorderArchive, streamingRank } from '@crm/core/file-safety';
import { MemoryStorageProvider } from '@crm/storage';
import ExcelJS from 'exceljs';
import { crc32, deflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { openUpload, UploadRejected, type SourceRow } from './parse.js';

/**
 * The parser is the only code that reads the bytes of a file a user supplied
 * (CLAUDE.md §5.12), so these tests are written as attacks: a name that lies, a
 * type that lies, a file that is too big, too wide, too tall, too deep.
 */
let storage: MemoryStorageProvider;

beforeEach(() => {
  storage = new MemoryStorageProvider();
});

const text = (value: string): Buffer => Buffer.from(value, 'utf8');

function put(bytes: Uint8Array, key = 'k'): string {
  storage.put(key, bytes);
  return key;
}

async function open(
  bytes: Uint8Array,
  claimed: 'csv' | 'xlsx' = 'csv',
  declaredSize: number | null = bytes.length,
) {
  const key = put(bytes);
  return openUpload(storage, { storageKey: key, claimedFormat: claimed, declaredSize });
}

async function collect(rows: AsyncGenerator<SourceRow>): Promise<SourceRow[]> {
  const out: SourceRow[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

async function rejectionOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(UploadRejected);
    return (error as Error).message;
  }
  throw new Error('Expected the upload to be rejected');
}

async function xlsx(build: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook.addWorksheet('Sheet1'));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('CSV', () => {
  it('reads a header and rows, reporting the row number the user would see', async () => {
    const opened = await open(text('name,email\nAda,ada@x.io\nGrace,grace@x.io\n'));
    expect(opened.header).toEqual(['name', 'email']);
    const rows = await collect(opened.rows);
    expect(rows.map((row) => row.cells)).toEqual([
      ['Ada', 'ada@x.io'],
      ['Grace', 'grace@x.io'],
    ]);
    expect(rows.map((row) => row.sourceRow)).toEqual([2, 3]);
  });

  it('handles quotes, embedded commas and newlines, a BOM and CRLF', async () => {
    const body = '﻿name,note\r\n"Smith, J","line1\nline2"\r\n"Q ""the"" Q",plain\r\n';
    const opened = await open(text(body));
    expect(opened.header).toEqual(['name', 'note']);
    const rows = await collect(opened.rows);
    expect(rows[0]?.cells).toEqual(['Smith, J', 'line1\nline2']);
    expect(rows[1]?.cells).toEqual(['Q "the" Q', 'plain']);
  });

  it('detects a semicolon delimiter', async () => {
    const opened = await open(text('name;email\nAda;ada@x.io\n'));
    expect(opened.header).toEqual(['name', 'email']);
  });

  it('skips blank rows and tolerates ragged ones', async () => {
    const opened = await open(text('a,b,c\n1,2\n\n,,\n3,4,5\n'));
    const rows = await collect(opened.rows);
    expect(rows.map((row) => row.cells)).toEqual([
      ['1', '2'],
      ['3', '4', '5'],
    ]);
  });

  it('undoes our own formula escape so an export can be re-imported', async () => {
    const opened = await open(text("a,b\n'-5.00 INR,'Neil\n"));
    const [row] = await collect(opened.rows);
    expect(row?.cells).toEqual(['-5.00 INR', "'Neil"]);
  });

  it('rejects a file with no rows', async () => {
    expect(await rejectionOf(() => open(text('\n\n')))).toMatch(/no rows/);
  });
});

describe('type by bytes, not by name (§5.12)', () => {
  it('rejects a .csv whose bytes are a zip', async () => {
    const workbook = await xlsx((sheet) => sheet.addRow(['a']));
    expect(await rejectionOf(() => open(workbook, 'csv'))).toMatch(/named \.csv.*zip/);
  });

  it('rejects an .xlsx that is plain text', async () => {
    expect(await rejectionOf(() => open(text('a,b\n1,2\n'), 'xlsx'))).toMatch(
      /named \.xlsx.*plain text/,
    );
  });

  it('rejects a PDF named .csv', async () => {
    expect(await rejectionOf(() => open(text('%PDF-1.7\n1 0 obj\n'), 'csv'))).toMatch(/PDF/);
  });

  it('rejects a Windows executable named .csv', async () => {
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64)]);
    expect(await rejectionOf(() => open(exe, 'csv'))).toMatch(/executable/);
  });

  it('rejects binary content that merely contains commas', async () => {
    const binary = Buffer.concat([text('a,b\n1,'), Buffer.from([0x00, 0x01, 0x02]), text('\n')]);
    expect(await rejectionOf(() => open(binary, 'csv'))).toMatch(/not a CSV/);
  });

  it('ignores the content type entirely: there is no parameter for one', async () => {
    // `openUpload` takes the claimed format from the filename and nothing else.
    const opened = await open(text('a\n1\n'), 'csv');
    expect(opened.format).toBe('csv');
  });
});

describe('size', () => {
  it('rejects a missing object', async () => {
    expect(
      await rejectionOf(() =>
        openUpload(storage, { storageKey: 'nope', claimedFormat: 'csv', declaredSize: 1 }),
      ),
    ).toMatch(/could not be found/);
  });

  it('rejects an object whose size is not the one declared', async () => {
    const bytes = text('a\n1\n');
    expect(await rejectionOf(() => open(bytes, 'csv', bytes.length + 1))).toMatch(
      /not the size that was declared/,
    );
  });

  it('rejects an object over the upload limit', async () => {
    const big = Buffer.alloc(IMPORT_LIMITS.maxUploadBytes + 1, 0x61);
    expect(await rejectionOf(() => open(big, 'csv'))).toMatch(/larger than the upload limit/);
  });
});

describe('parsing limits', () => {
  it('rejects more rows than the ceiling, partway through, without reading the rest', async () => {
    const lines = ['a'];
    for (let i = 0; i < IMPORT_LIMITS.maxRows + 1; i += 1) lines.push(String(i));
    const opened = await open(text(lines.join('\n')));
    expect(await rejectionOf(() => collect(opened.rows))).toMatch(/more than 100000 rows/);
  });

  it('accepts exactly the row ceiling', async () => {
    const lines = ['a'];
    for (let i = 0; i < IMPORT_LIMITS.maxRows; i += 1) lines.push(String(i));
    const opened = await open(text(lines.join('\n')));
    expect((await collect(opened.rows)).length).toBe(IMPORT_LIMITS.maxRows);
  });

  it('rejects a CSV with too many columns', async () => {
    const wide = Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
    expect(await rejectionOf(() => open(text(`${wide}\n1\n`)))).toMatch(/more than 200 columns/);
  });

  it('rejects a cell longer than the limit', async () => {
    const huge = 'x'.repeat(IMPORT_LIMITS.maxCellChars + 1);
    const opened = await open(text(`a,b\n1,${huge}\n`));
    expect(await rejectionOf(() => collect(opened.rows))).toMatch(/longer than 32000 characters/);
  });

  it('rejects an unterminated quote cleanly, with no file content in the message', async () => {
    const message = await rejectionOf(async () => {
      const opened = await open(text('a,b\n"never closed,secret-value\n'));
      await collect(opened.rows);
    });
    expect(message).toMatch(/could not be parsed/);
    expect(message).not.toContain('secret-value');
  });
});

describe('XLSX', () => {
  it('reads a real workbook: strings, numbers, booleans and dates', async () => {
    const workbook = await xlsx((sheet) => {
      sheet.addRow(['name', 'amount', 'active', 'joined']);
      sheet.addRow(['Ada', 1500.5, true, new Date('2026-03-04T00:00:00Z')]);
    });
    const opened = await open(workbook, 'xlsx');
    expect(opened.format).toBe('xlsx');
    expect(opened.header).toEqual(['name', 'amount', 'active', 'joined']);
    const [row] = await collect(opened.rows);
    expect(row?.cells).toEqual(['Ada', '1500.5', 'true', '2026-03-04']);
    expect(row?.sourceRow).toBe(2);
  });

  it('takes a formula’s result, never its text', async () => {
    const workbook = await xlsx((sheet) => {
      sheet.addRow(['v']);
      sheet.addRow([{ formula: '1+1', result: 2 }]);
      sheet.addRow([{ formula: 'HYPERLINK("http://evil","x")', result: undefined }]);
    });
    const opened = await open(workbook, 'xlsx');
    const rows = await collect(opened.rows);
    expect(rows.map((row) => row.cells[0])).toEqual(['2']);
  });

  it('reads a workbook whose sheets come *before* its description in the zip', async () => {
    // Writers disagree about entry order (ExcelJS's own varies run to run), and a
    // streaming reader that assumes one rejects valid files. Build the worst
    // order on purpose: sheets first, `[Content_Types].xml` last.
    const workbook = await xlsx((sheet) => {
      sheet.addRow(['name', 'email']);
      sheet.addRow(['Ada', 'ada@x.io']);
    });
    const worst = reorderArchive(workbook, (name) => -streamingRank(name));
    const opened = await open(worst, 'xlsx');
    expect(opened.header).toEqual(['name', 'email']);
    expect((await collect(opened.rows)).map((row) => row.cells)).toEqual([['Ada', 'ada@x.io']]);
  });

  it('reads workbooks reliably, run after run', async () => {
    for (let i = 0; i < 15; i += 1) {
      const workbook = await xlsx((sheet) => {
        sheet.addRow(['n']);
        sheet.addRow([`v${i}`]);
      });
      const opened = await open(workbook, 'xlsx');
      expect((await collect(opened.rows)).map((row) => row.cells[0])).toEqual([`v${i}`]);
    }
  });

  it('rejects a sheet with a cell far to the right ("a million columns")', async () => {
    const workbook = await xlsx((sheet) => {
      sheet.addRow(['a']);
      sheet.getCell(2, 16384).value = 'far away';
    });
    const opened = await open(workbook, 'xlsx');
    expect(await rejectionOf(() => collect(opened.rows))).toMatch(/more than 200 columns/);
  });

  it('rejects a zip that is not a workbook', async () => {
    const zip = buildZip([{ name: 'hello.txt', data: Buffer.from('hi') }]);
    expect(await rejectionOf(() => open(zip, 'xlsx'))).toMatch(/not an Excel workbook/);
  });

  it('rejects a decompression bomb dressed as a workbook, before inflating it', async () => {
    const bomb = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      // ~220 MB of zeros inflating from a few hundred KB.
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(220 * 1024 * 1024) },
    ]);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);

    const rejected = await open(bomb, 'xlsx').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(rejected).toBeInstanceOf(UploadRejected);
    expect((rejected as UploadRejected).message).toMatch(/more data than is allowed/);

    // Counted bytes, not elapsed seconds: the worker stopped at the ceiling and
    // did not inflate all 220 MB, however loaded the machine running this is.
    const cause = (rejected as UploadRejected).cause as { inflatedBytes?: number };
    expect(cause.inflatedBytes).toBeGreaterThan(IMPORT_LIMITS.maxInflatedBytes);
    expect(cause.inflatedBytes).toBeLessThan(IMPORT_LIMITS.maxInflatedBytes + 1024 * 1024);
  }, 120_000);

  it('rejects a workbook whose header lies about its size', async () => {
    const lying = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(50_000), declaredSize: 5 },
    ]);
    expect(await rejectionOf(() => open(lying, 'xlsx'))).toMatch(/sizes do not match/);
  });
});

// A minimal zip writer that can write archives that lie. See core's zip.spec.ts.
function buildZip(
  entries: readonly { name: string; data: Buffer; declaredSize?: number }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const declared = entry.declaredSize ?? entry.data.length;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
