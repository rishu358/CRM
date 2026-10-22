import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The boundary (CLAUDE.md §5.13, ADR-0040): no raw network call outside an adapter.
 *
 * `OutboundHttp` only protects what goes through it. This reads the source and fails if
 * anything else opens a connection, so the guard cannot be bypassed by someone who did
 * not know it was there. Each place that legitimately makes a call is listed below with
 * the reason, and the list is checked both ways: a call that is not listed fails, and an
 * entry whose call has gone away fails, so the list cannot rot into a blanket exemption.
 *
 * What this does not see: the AWS SDK's S3 calls (configured with one fixed endpoint, in
 * `packages/storage`), and Better Auth's sign-in with Google (fixed hosts, inside the
 * library). Neither takes a destination from a user.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED = ['apps/api/src', 'apps/worker/src', 'apps/web/src', 'packages'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo']);

/** A way to open a connection, or to weaken the one that is opened. */
const PATTERNS: readonly { name: string; test: RegExp }[] = [
  { name: 'fetch', test: /\bfetch\s*\(/ },
  {
    name: 'node network module',
    test: /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
  },
  {
    name: 'require of a network module',
    test: /require\(\s*['"](?:node:)?(?:http|https|net|tls|dns)['"]\s*\)/,
  },
  { name: 'http library', test: /['"](?:undici|axios|got|node-fetch|ws|superagent|request)['"]/ },
  {
    name: 'browser network API',
    test: /\b(?:XMLHttpRequest|new WebSocket|new EventSource|sendBeacon)\b/,
  },
  {
    name: 'TLS verification switched off',
    test: /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/,
  },
  { name: 'the test-only client', test: /@crm\/outbound\/testing/ },
];

interface Allowed {
  readonly file: string;
  readonly pattern: string;
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: 'apps/web/src/app/api/proxy/[...path]/route.ts',
    pattern: 'fetch',
    reason:
      'Forwards to API_URL, a fixed origin from configuration, on a path built by `upstreamPath`. The caller chooses neither host nor scheme.',
  },
  {
    file: 'apps/web/src/app/api/session/route.ts',
    pattern: 'fetch',
    reason:
      'Calls the sign-in and sign-out endpoints of API_URL, a fixed origin, with fixed paths.',
  },
  {
    file: 'apps/web/src/lib/api-client.ts',
    pattern: 'fetch',
    reason: 'Runs in the browser and calls this app’s own `/api/proxy`.',
  },
  {
    file: 'apps/web/src/lib/session.ts',
    pattern: 'fetch',
    reason: 'Runs in the browser and calls this app’s own `/api/session` and `/api/proxy`.',
  },
  {
    file: 'apps/web/src/lib/attachments.ts',
    pattern: 'fetch',
    reason:
      'Runs in the browser and uploads to the presigned URL the API issued for it (CLAUDE.md §5.12). Not a server.',
  },
  {
    file: 'apps/web/src/lib/import-export.ts',
    pattern: 'fetch',
    reason:
      'Runs in the browser and uploads to the presigned URL the API issued for it. Not a server.',
  },
  {
    file: 'apps/api/src/perf/load-run.ts',
    pattern: 'fetch',
    reason:
      'A load-test tool run by hand against a scratch environment whose URL the operator passes on the command line. Excluded from the production build and never imported by the service.',
  },
  {
    file: 'packages/outbound/src/client.ts',
    pattern: 'node network module',
    reason:
      'The guarded client itself: the one place that opens a connection for an address a user chose.',
  },
];

/** Files whose purpose is to talk about these patterns, or that are tests. */
function isExempt(path: string): boolean {
  return (
    /\.(?:spec|test)\.tsx?$/.test(path) ||
    path.startsWith('packages/outbound/src/boundary.spec') ||
    // UI components never run on a server and the design system makes no requests.
    path.startsWith('packages/ui/')
  );
}

function sources(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const full = join(directory, name);
    const stats = statSync(full);
    if (stats.isDirectory()) sources(full, out);
    else if (/\.(?:ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Source text with comments removed, so prose about `fetch(` is not a call to it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

interface Found {
  readonly file: string;
  readonly pattern: string;
}

function scan(): Found[] {
  const found: Found[] = [];
  for (const base of SCANNED) {
    const directory = join(ROOT, base);
    for (const full of sources(directory)) {
      const file = relative(ROOT, full).split('\\').join('/');
      if (isExempt(file)) continue;
      const text = code(readFileSync(full, 'utf8'));
      for (const pattern of PATTERNS) {
        if (pattern.test.test(text)) found.push({ file, pattern: pattern.name });
      }
    }
  }
  return found;
}

describe('no raw network call outside an adapter', () => {
  const found = scan();

  it('finds the source it is meant to scan', () => {
    const files = new Set(found.map((entry) => entry.file));
    // If the scan matched nothing at all it could be looking in the wrong place.
    expect(files.size).toBeGreaterThan(5);
    expect(files.has('apps/web/src/app/api/proxy/[...path]/route.ts')).toBe(true);
  });

  it('allows only the calls listed, each with a reason', () => {
    const listed = new Set(ALLOWED.map((entry) => `${entry.file}::${entry.pattern}`));
    const unexpected = found
      .filter((entry) => !listed.has(`${entry.file}::${entry.pattern}`))
      .map((entry) => `${entry.file} (${entry.pattern})`);
    expect(unexpected).toEqual([]);
  });

  it('keeps no entry for a call that is gone', () => {
    const present = new Set(found.map((entry) => `${entry.file}::${entry.pattern}`));
    const stale = ALLOWED.filter((entry) => !present.has(`${entry.file}::${entry.pattern}`)).map(
      (entry) => `${entry.file} (${entry.pattern})`,
    );
    expect(stale).toEqual([]);
  });

  it('gives every entry a reason that says something', () => {
    for (const entry of ALLOWED) expect(entry.reason.length, entry.file).toBeGreaterThan(40);
  });

  it('never switches TLS verification off, anywhere', () => {
    expect(found.filter((entry) => entry.pattern === 'TLS verification switched off')).toEqual([]);
  });

  it('keeps the test-only client out of anything that ships', () => {
    expect(found.filter((entry) => entry.pattern === 'the test-only client')).toEqual([]);
  });
});

describe('what the scanner can and cannot be fooled by', () => {
  it('ignores a call mentioned in a comment, and sees one that is not', () => {
    expect(PATTERNS[0]!.test.test(code('// we never fetch(url) here'))).toBe(false);
    expect(PATTERNS[0]!.test.test(code('/* fetch(url) */ const x = 1;'))).toBe(false);
    expect(PATTERNS[0]!.test.test(code('const r = await fetch(url);'))).toBe(true);
    expect(PATTERNS[0]!.test.test(code('await globalThis.fetch(url)'))).toBe(true);
  });

  it('does not mistake a similarly named function for the call', () => {
    expect(PATTERNS[0]!.test.test('query.fetchNextPage()')).toBe(false);
    expect(PATTERNS[0]!.test.test('await refetch()')).toBe(false);
    expect(PATTERNS[0]!.test.test('client.prefetch(x)')).toBe(false);
  });

  it('sees each way of importing a network module', () => {
    expect(PATTERNS[1]!.test.test("import http from 'node:http';")).toBe(true);
    expect(PATTERNS[1]!.test.test('import { connect } from "net";')).toBe(true);
    expect(PATTERNS[1]!.test.test("import dns from 'node:dns';")).toBe(true);
    expect(PATTERNS[2]!.test.test("const net = require('node:net');")).toBe(true);
    expect(PATTERNS[3]!.test.test("import axios from 'axios';")).toBe(true);
    expect(PATTERNS[3]!.test.test("import { fetch } from 'undici';")).toBe(true);
  });
});
