import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hosted lead form is the one page of this app a stranger opens on the app's own origin
 * (ADR-0065 5.1), so what it draws must never be markup. Everything on it is a company's own words
 * or a visitor's, and React escapes a string child; `dangerouslySetInnerHTML` would undo that.
 */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.spec\./.test(name) ? [path] : [];
  });
}

const HERE = __dirname;
const COMPONENTS = join(HERE, '..', '..', 'components');
const PUBLIC_FILES = [
  ...sources(HERE),
  join(COMPONENTS, 'public-lead-form.tsx'),
  join(COMPONENTS, 'lead-form-fields.tsx'),
];

describe('the hosted lead form page', () => {
  it('has files to check', () => {
    expect(PUBLIC_FILES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(PUBLIC_FILES.map((file) => [file.slice(file.indexOf('src')), file] as const))(
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

  it('sends no credential of its own: it reads no cookie and no token', () => {
    for (const file of PUBLIC_FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/document\.cookie|localStorage|sessionStorage|SESSION_COOKIE_NAME/);
    }
  });
});
