import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMITS,
  attachmentContentType,
  attachmentExtension,
  attachmentFileNameProblem,
  attachmentFormatMismatch,
  detectAttachmentFormat,
} from './attachments.js';

/**
 * The attachment file policy (CLAUDE.md §5.12, ADR-0035).
 *
 * The cases here are the ones an attachment has and other records do not: a
 * filename an attacker chose that ends up in a header, and bytes that are not
 * what the name says they are.
 */
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('the filename is refused, not repaired', () => {
  it.each([
    ['a forward slash', '../../etc/passwd', 'path_separator'],
    ['a backslash', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'path_separator'],
    ['a bare traversal sequence', 'report..pdf', 'traversal'],
    ['a NUL byte', 'report\u0000.pdf', 'control_character'],
    ['a carriage return and a header', 'a.pdf"\r\nSet-Cookie: x=1', 'control_character'],
    ['a line feed', 'report\n.pdf', 'control_character'],
    // `invoice<U+202E>gnp.exe` renders to a reader as `invoice exe.png`.
    ['a right-to-left override', 'invoice\u202egnp.exe', 'bidi_override'],
    ['a left-to-right override', 'invoice\u202dgnp.exe', 'bidi_override'],
    ['an invisible direction mark', 'invoice\u200f.pdf', 'bidi_override'],
    ['nothing but whitespace', '   ', 'empty'],
    ['an executable extension', 'payload.exe', 'extension_not_allowed'],
    ['a double extension', 'report.pdf.exe', 'extension_not_allowed'],
    ['no extension at all', 'report', 'extension_not_allowed'],
    // The one browsers render with script if they ever render it at all.
    ['an SVG', 'logo.svg', 'extension_not_allowed'],
    ['an HTML page', 'page.html', 'extension_not_allowed'],
    ['XML', 'data.xml', 'extension_not_allowed'],
  ])('refuses %s', (_label, name, expected) => {
    expect(attachmentFileNameProblem(name)).toBe(expected);
  });

  it('refuses a 300-character name, and accepts one at the ceiling', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    expect(attachmentFileNameProblem(long)).toBe('too_long');

    const atLimit = `${'a'.repeat(ATTACHMENT_LIMITS.maxFileNameChars - 4)}.pdf`;
    expect([...atLimit]).toHaveLength(ATTACHMENT_LIMITS.maxFileNameChars);
    expect(attachmentFileNameProblem(atLimit)).toBeNull();
  });

  it('counts characters, not UTF-16 code units, so emoji do not halve the limit', () => {
    // 250 astral characters is 500 code units: `.length` would call this too long.
    const name = `${'😀'.repeat(250)}.pdf`;
    expect(name.length).toBeGreaterThan(ATTACHMENT_LIMITS.maxFileNameChars);
    expect(attachmentFileNameProblem(name)).toBeNull();
  });

  it.each([
    'Q3 report (final).pdf',
    'facture-été.pdf',
    'स्क्रीनशॉट.png',
    'notes.txt',
    'Book1.XLSX',
  ])('accepts an ordinary name: %s', (name) => {
    expect(attachmentFileNameProblem(name)).toBeNull();
  });
});

describe('the content type comes from our list, never from the client', () => {
  it('maps the extension case-insensitively', () => {
    expect(attachmentContentType('Photo.JPG')).toBe('image/jpeg');
    expect(attachmentContentType('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('has nothing a browser renders as a document on it', () => {
    for (const extension of ALLOWED_ATTACHMENT_EXTENSIONS) {
      const mime = attachmentContentType(`file.${extension}`);
      expect(mime).not.toBeNull();
      expect(mime).not.toMatch(/html|svg|xml$/);
    }
  });

  it('reads the last extension, which is the one the OS obeys', () => {
    expect(attachmentExtension('report.pdf.exe')).toBe('exe');
    expect(attachmentContentType('report.pdf.exe')).toBeNull();
  });
});

describe('detectAttachmentFormat: type by bytes, never by name', () => {
  it.each([
    ['a PDF', bytes(0x25, 0x50, 0x44, 0x46, 0x2d), 'pdf'],
    ['a PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d), 'png'],
    ['a JPEG', bytes(0xff, 0xd8, 0xff, 0xe0), 'jpeg'],
    ['a GIF', text('GIF89a'), 'gif'],
    ['a zip', bytes(0x50, 0x4b, 0x03, 0x04, 0, 0), 'zip'],
    ['plain text', text('hello, world\n'), 'text'],
  ])('recognises %s', (_label, prefix, format) => {
    expect(detectAttachmentFormat(prefix)).toEqual({ ok: true, format });
  });

  it('recognises a WebP only when the RIFF container says WEBP', () => {
    const webp = Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WEBP')]);
    expect(detectAttachmentFormat(webp)).toEqual({ ok: true, format: 'webp' });
  });

  it.each([
    ['a Windows executable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['an ELF executable', bytes(0x7f, 0x45, 0x4c, 0x46)],
    ['a shell script', text('#!/bin/sh\nrm -rf /\n')],
    ['a legacy Office (.xls/.doc) file', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1)],
    ['a gzip archive', bytes(0x1f, 0x8b, 0x08)],
    ['a RAR archive', text('Rar!')],
  ])('refuses %s whatever it is named', (label, prefix) => {
    const result = detectAttachmentFormat(prefix);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(label);
  });

  it('refuses bytes that are neither a known format nor plausibly text', () => {
    expect(detectAttachmentFormat(bytes(0x61, 0x00, 0x01, 0x02)).ok).toBe(false);
    expect(detectAttachmentFormat(bytes(0x61, 0x2c, 0xc3, 0x28, 0x0a)).ok).toBe(false);
  });

  it('refuses an empty file: there is nothing to decide a type from', () => {
    expect(detectAttachmentFormat(new Uint8Array())).toEqual({
      ok: false,
      reason: 'The file is empty',
    });
  });
});

describe('the claim and the bytes must agree', () => {
  it('accepts agreement, including every OOXML name being a zip', () => {
    expect(attachmentFormatMismatch('photo.png', 'png')).toBeNull();
    expect(attachmentFormatMismatch('deck.pptx', 'zip')).toBeNull();
    expect(attachmentFormatMismatch('notes.csv', 'text')).toBeNull();
  });

  it('rejects a .png whose bytes are a zip', () => {
    expect(attachmentFormatMismatch('logo.png', 'zip')).toMatch(/named \.png/);
  });

  it('rejects a .pdf that is really text, and a .txt that is really a PDF', () => {
    expect(attachmentFormatMismatch('contract.pdf', 'text')).not.toBeNull();
    expect(attachmentFormatMismatch('notes.txt', 'pdf')).not.toBeNull();
  });

  it('rejects a name with no extension we accept, whatever the bytes are', () => {
    expect(attachmentFormatMismatch('payload.exe', 'pdf')).not.toBeNull();
  });
});
