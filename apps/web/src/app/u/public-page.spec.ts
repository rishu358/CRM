import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The unsubscribe pages are opened by a stranger from an email, on the app's own origin (ADR-0076), so what
 * they draw must never be markup and what they send must never be a credential. The company name on the page
 * is a company's own words, and React escapes a string child; `dangerouslySetInnerHTML` would undo that.
 */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.spec\./.test(name) ? [path] : [];
  });
}

const HERE = __dirname;
const FILES = [...sources(HERE), join(HERE, '..', '..', 'lib', 'unsubscribe-server.ts')];

describe('the unsubscribe pages', () => {
  it('has the files to check: the question, the answer, the handler and the server helper', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(4);
  });

  it.each(FILES.map((file) => [file.slice(file.indexOf('src')), file] as const))(
    '%s never writes raw HTML or runs a string as code',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        'eval(',
        'new Function',
        'document.write',
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    },
  );

  it('sends no credential of its own: it reads no cookie and no token of a session', () => {
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/document\.cookie|localStorage|sessionStorage|SESSION_COOKIE_NAME/);
      expect(text).not.toMatch(/cookies\(\)|authorization/i);
    }
  });

  it('keeps the token out of anything it sends on: no referrer, no index, never cached', () => {
    const page = readFileSync(join(HERE, '[token]', 'page.tsx'), 'utf8');
    expect(page).toContain("referrer: 'no-referrer'");
    expect(page).toContain('index: false');
    const handler = readFileSync(join(HERE, '[token]', 'confirm', 'route.ts'), 'utf8');
    expect(handler).toContain("'referrer-policy': 'no-referrer'");
    expect(handler).toContain("'cache-control': 'no-store'");
  });

  it('only asks when opened: the page has no code that unsubscribes, and the handler is a POST', () => {
    const page = readFileSync(join(HERE, '[token]', 'page.tsx'), 'utf8');
    expect(page).not.toContain('submitUnsubscribe');
    expect(page).toContain('method="post"');
    const handler = readFileSync(join(HERE, '[token]', 'confirm', 'route.ts'), 'utf8');
    expect(handler).toMatch(/export async function POST/);
    expect(handler).not.toMatch(/export async function GET/);
  });
});
