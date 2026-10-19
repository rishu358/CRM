import { describe, expect, it } from 'vitest';
import {
  claimedFormatFromFileName,
  detectUploadFormat,
  formatMismatch,
  MAGIC_BYTES_PREFIX_LENGTH,
} from './magic-bytes.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('detectUploadFormat: type by bytes, never by name (§5.12)', () => {
  it('accepts plain CSV text', () => {
    expect(detectUploadFormat(text('first_name,last_name\nAda,Lovelace\n'))).toEqual({
      ok: true,
      format: 'csv',
    });
  });

  it('accepts CSV with a UTF-8 byte-order mark and with non-ASCII text', () => {
    expect(
      detectUploadFormat(Buffer.concat([bytes(0xef, 0xbb, 0xbf), text('name\nZoë\n')])),
    ).toEqual({ ok: true, format: 'csv' });
    expect(detectUploadFormat(text('name\nÅsa, 山田, 😀\n'))).toEqual({ ok: true, format: 'csv' });
  });

  it('does not reject a UTF-8 file because the prefix ends mid-character', () => {
    const full = text('é'.repeat(MAGIC_BYTES_PREFIX_LENGTH));
    // Slicing at an odd length lands inside a two-byte character.
    expect(detectUploadFormat(full.subarray(0, MAGIC_BYTES_PREFIX_LENGTH - 1))).toEqual({
      ok: true,
      format: 'csv',
    });
  });

  it('identifies a zip as an xlsx *candidate*, not as an xlsx', () => {
    expect(detectUploadFormat(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0))).toEqual({
      ok: true,
      format: 'xlsx_candidate',
    });
  });

  it.each([
    ['a PDF', bytes(0x25, 0x50, 0x44, 0x46, 0x2d)],
    ['a Windows executable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['an ELF executable', bytes(0x7f, 0x45, 0x4c, 0x46)],
    ['a PNG image', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['a JPEG image', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['a GIF image', text('GIF89a')],
    ['a legacy Office (.xls/.doc) file', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1)],
    ['a gzip archive', bytes(0x1f, 0x8b, 0x08)],
    ['a shell script', text('#!/bin/sh\nrm -rf /\n')],
  ])('rejects %s however it is named', (name, prefix) => {
    const result = detectUploadFormat(prefix);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(name);
  });

  it('rejects text with NUL bytes', () => {
    const result = detectUploadFormat(text('a,b\n1,\u0000\n'));
    expect(result.ok).toBe(false);
  });

  it('rejects binary control characters', () => {
    expect(detectUploadFormat(bytes(0x61, 0x2c, 0x01, 0x02, 0x03)).ok).toBe(false);
  });

  it('rejects invalid UTF-8', () => {
    expect(detectUploadFormat(bytes(0x61, 0x2c, 0xc3, 0x28, 0x0a)).ok).toBe(false);
  });

  it('rejects UTF-16 with a clear reason', () => {
    const result = detectUploadFormat(bytes(0xff, 0xfe, 0x61, 0x00));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('UTF-16');
  });

  it('rejects an empty file', () => {
    expect(detectUploadFormat(new Uint8Array())).toEqual({
      ok: false,
      reason: 'The file is empty',
    });
  });
});

describe('the uploader’s claim is compared with the bytes', () => {
  it('reads the claim from the extension, case-insensitively', () => {
    expect(claimedFormatFromFileName('Customers.CSV')).toBe('csv');
    expect(claimedFormatFromFileName('book.xlsx')).toBe('xlsx');
    expect(claimedFormatFromFileName('book.xls')).toBeNull();
    expect(claimedFormatFromFileName('script.csv.exe')).toBeNull();
  });

  it('accepts agreement', () => {
    expect(formatMismatch('csv', 'csv')).toBeNull();
    expect(formatMismatch('xlsx', 'xlsx_candidate')).toBeNull();
  });

  it('rejects a .csv whose bytes are a zip', () => {
    expect(formatMismatch('csv', 'xlsx_candidate')).toMatch(/named \.csv.*zip/);
  });

  it('rejects an .xlsx whose bytes are plain text', () => {
    expect(formatMismatch('xlsx', 'csv')).toMatch(/named \.xlsx.*plain text/);
  });
});
