import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../import-export/limits.js';
import {
  inspectXlsxArchive,
  readCentralDirectory,
  reorderArchive,
  streamingRank,
  UnsafeArchiveError,
} from './zip.js';

/**
 * A hand-rolled zip writer, because the thing under test must be fed archives
 * that *lie* — wrong sizes, impossible ratios, hostile names — and no zip
 * library will write those on request.
 */
interface FixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly method?: 0 | 8;
  /** Override what the headers claim, to build an archive that lies. */
  readonly declaredSize?: number;
  readonly flags?: number;
}

function buildZip(entries: readonly FixtureEntry[], options: { totalEntriesField?: number } = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const declared = entry.declaredSize ?? entry.data.length;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
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
  eocd.writeUInt16LE(options.totalEntriesField ?? entries.length, 8);
  eocd.writeUInt16LE(options.totalEntriesField ?? entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const workbookParts = (): FixtureEntry[] => [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
  {
    name: 'xl/worksheets/sheet1.xml',
    data: Buffer.from('<worksheet>' + 'x'.repeat(2000) + '</worksheet>'),
  },
];

async function rejection(buffer: Buffer): Promise<string> {
  try {
    await inspectXlsxArchive(buffer);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    return (error as Error).message;
  }
  throw new Error('Expected the archive to be rejected');
}

describe('inspectXlsxArchive: a zip is a decompression bomb until proven otherwise (§5.12)', () => {
  it('accepts a real-shaped workbook', async () => {
    const report = await inspectXlsxArchive(buildZip(workbookParts()));
    expect(report.entryCount).toBe(3);
    expect(report.inflatedBytes).toBeGreaterThan(2000);
  });

  it('accepts stored (uncompressed) entries', async () => {
    const parts = workbookParts().map((part) => ({ ...part, method: 0 as const }));
    await expect(inspectXlsxArchive(buildZip(parts))).resolves.toMatchObject({ entryCount: 3 });
  });

  it('rejects a zip that is not a workbook', async () => {
    const message = await rejection(buildZip([{ name: 'hello.txt', data: Buffer.from('hi') }]));
    expect(message).toMatch(/not an Excel workbook/);
  });

  it('rejects a bomb by ratio: a few KB that inflate to megabytes', async () => {
    const bomb = Buffer.alloc(IMPORT_LIMITS.ratioCheckFloorBytes * 5); // zeros
    const message = await rejection(
      buildZip([...workbookParts(), { name: 'xl/worksheets/sheet2.xml', data: bomb }]),
    );
    expect(message).toMatch(/more data than is allowed/);
  });

  it('rejects a bomb that exceeds the total inflated ceiling, without inflating all of it', async () => {
    const overshoot = 50 * 1024 * 1024;
    const huge = Buffer.alloc(IMPORT_LIMITS.maxInflatedBytes + overshoot);
    const archive = buildZip([
      ...workbookParts(),
      { name: 'xl/worksheets/sheet2.xml', data: huge },
    ]);

    const error = await inspectXlsxArchive(archive).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    const refused = error as UnsafeArchiveError;
    expect(refused.message).toMatch(/more data than is allowed/);

    // It stopped counting at the budget instead of finishing a 250 MB inflate.
    // Asserted on bytes, not on seconds: a time bound measures the machine and
    // fails under load, while this is true however slow the run is.
    expect(refused.inflatedBytes).toBeGreaterThan(IMPORT_LIMITS.maxInflatedBytes);
    expect(refused.inflatedBytes).toBeLessThan(IMPORT_LIMITS.maxInflatedBytes + 1024 * 1024);
    expect(refused.inflatedBytes).toBeLessThan(huge.length);
  }, 120_000);

  it('rejects an archive whose header lies about an entry’s size', async () => {
    // Declares 10 bytes, really inflates to 100,000. A parser trusting the
    // header would allocate for 10.
    const message = await rejection(
      buildZip([
        ...workbookParts(),
        { name: 'xl/worksheets/sheet2.xml', data: Buffer.alloc(100_000), declaredSize: 10 },
      ]),
    );
    expect(message).toMatch(/sizes do not match/);
  });

  it('rejects too many entries', async () => {
    const many = Array.from({ length: IMPORT_LIMITS.maxZipEntries + 1 }, (_, index) => ({
      name: `xl/part${index}.xml`,
      data: Buffer.from('<a/>'),
    }));
    const message = await rejection(buildZip([...workbookParts(), ...many]));
    expect(message).toMatch(/parts; the limit is/);
  });

  it('rejects encrypted entries', async () => {
    const parts = workbookParts();
    const message = await rejection(buildZip([{ ...parts[0]!, flags: 1 }, ...parts.slice(1)]));
    expect(message).toMatch(/Encrypted/);
  });

  it.each(['../evil.xml', '/etc/passwd', 'xl\\..\\evil.xml', 'a/../../b.xml'])(
    'rejects the unsafe part name %s',
    async (name) => {
      const message = await rejection(
        buildZip([...workbookParts(), { name, data: Buffer.from('<a/>') }]),
      );
      expect(message).toMatch(/unsafe part name/);
    },
  );

  it('rejects zip64 markers', async () => {
    const message = await rejection(buildZip(workbookParts(), { totalEntriesField: 0xffff }));
    expect(message).toMatch(/Zip64/);
  });

  it('rejects a truncated archive and random bytes starting with PK', async () => {
    const good = buildZip(workbookParts());
    expect(await rejection(good.subarray(0, good.length - 30))).toMatch(/not a valid zip/);
    expect(await rejection(Buffer.from('PK\u0003\u0004 not really a zip at all'))).toMatch(
      /not a valid zip/,
    );
  });

  it('rejects corrupt deflate data cleanly', async () => {
    const parts = workbookParts();
    const archive = buildZip(parts);
    // Corrupt the first entry's compressed bytes (just after its local header).
    const start = 30 + parts[0]!.name.length;
    archive.fill(0xff, start, start + 4);
    expect(await rejection(archive)).toMatch(/corrupt/);
  });
});

describe('readCentralDirectory', () => {
  it('lists entries without inflating anything', () => {
    const entries = readCentralDirectory(buildZip(workbookParts()));
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });
});

describe('reorderArchive: a streaming parser needs the workbook before the sheets', () => {
  const sheetFirst = (): FixtureEntry[] => [
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from('<worksheet>' + 'x'.repeat(5000) + '</worksheet>'),
    },
    { name: 'xl/styles.xml', data: Buffer.from('<styleSheet/>') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst/>') },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  ];

  it('puts the description and lookup tables first and the sheets last', () => {
    const reordered = reorderArchive(buildZip(sheetFirst()));
    expect(readCentralDirectory(reordered).map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('copies the compressed bytes: the result is still a valid, safe workbook with the same content', async () => {
    const original = buildZip(sheetFirst());
    const reordered = reorderArchive(original);

    const before = await inspectXlsxArchive(original);
    const after = await inspectXlsxArchive(reordered);
    expect(after).toEqual(before);

    // Each entry keeps its CRC and sizes.
    const byName = (buffer: Buffer) =>
      new Map(readCentralDirectory(buffer).map((entry) => [entry.name, entry]));
    for (const [name, entry] of byName(original)) {
      const moved = byName(reordered).get(name);
      expect(moved?.crc32).toBe(entry.crc32);
      expect(moved?.declaredSize).toBe(entry.declaredSize);
      expect(moved?.compressedSize).toBe(entry.compressedSize);
    }
  });

  it('is stable for entries of equal rank, and an already-ordered archive is unchanged in order', () => {
    const ordered = [...sheetFirst()].sort((a, b) => streamingRank(a.name) - streamingRank(b.name));
    const names = readCentralDirectory(reorderArchive(buildZip(ordered))).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(ordered.map((entry) => entry.name));
  });

  it('accepts a custom ranking, which tests use to build worst-case archives', () => {
    const reversed = reorderArchive(buildZip(workbookParts()), (name) => -streamingRank(name));
    expect(readCentralDirectory(reversed).at(-1)?.name).toBe('[Content_Types].xml');
  });
});
