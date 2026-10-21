import { describe, expect, it } from 'vitest';
import { upstreamPath } from './proxy-path';

describe('upstreamPath', () => {
  it('builds the versioned path from route segments', () => {
    expect(upstreamPath(['contacts'])).toBe('/api/v1/contacts');
    expect(upstreamPath(['contacts', '0198f0f0-0000-7000-8000-000000000000'])).toBe(
      '/api/v1/contacts/0198f0f0-0000-7000-8000-000000000000',
    );
    expect(upstreamPath(['deals', 'board'])).toBe('/api/v1/deals/board');
  });

  it('keeps an odd but harmless segment as one encoded segment', () => {
    expect(upstreamPath(['search', 'a b'])).toBe('/api/v1/search/a%20b');
    expect(upstreamPath(['x', 'ü'])).toBe('/api/v1/x/%C3%BC');
    expect(upstreamPath(['x', '%2e'])).toBe('/api/v1/x/%252e');
  });

  it.each([
    ['a parent segment', ['..']],
    ['a parent segment after a real one', ['contacts', '..', 'health']],
    ['a current-directory segment', ['.']],
    ['a segment with a slash in it (a decoded %2F)', ['..', 'health'].join('/')],
    ['a slash-bearing segment', ['contacts/../health']],
    ['a backslash, which some servers read as a slash', ['contacts\\..\\health']],
    ['an empty segment, which would collapse a path', ['contacts', '', 'x']],
    ['a NUL byte', ['contacts\u0000']],
    ['a newline, for header smuggling', ['contacts\r\nHost: evil']],
    ['a DEL', ['x\u007f']],
    ['no segments at all', []],
  ])('refuses %s', (_name, segments) => {
    expect(upstreamPath(typeof segments === 'string' ? [segments] : segments)).toBeNull();
  });

  it('refuses an absurdly deep or long path', () => {
    expect(upstreamPath(Array.from({ length: 21 }, () => 'a'))).toBeNull();
    expect(upstreamPath(['a'.repeat(201)])).toBeNull();
    expect(upstreamPath(Array.from({ length: 20 }, () => 'a'))).not.toBeNull();
  });

  it('never produces a path outside /api/v1, whatever it is given', () => {
    const hostile = [
      '..',
      '.',
      '%2e%2e',
      '..%2f',
      '/',
      '//evil.example',
      'http://evil.example',
      '@evil',
    ];
    for (const first of hostile) {
      for (const second of hostile) {
        const path = upstreamPath(['contacts', first, second]);
        if (path === null) continue;
        const resolved = new URL(path, 'http://api.internal');
        expect(resolved.host).toBe('api.internal');
        expect(resolved.pathname.startsWith('/api/v1/')).toBe(true);
      }
    }
  });
});
