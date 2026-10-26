import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allVariables } from './load.js';

/**
 * `docs/SECRETS.md` lists every secret (ADR-0049). A secret added to the registry and not to that page is a
 * secret nobody has said how to rotate, so adding one without the other fails the build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const page = readFileSync(resolve(ROOT, 'docs/SECRETS.md'), 'utf8');

describe('docs/SECRETS.md', () => {
  const secrets = allVariables()
    .filter(([, definition]) => definition.secret === true)
    .map(([name]) => name);

  it('finds the secrets it is meant to cover', () => {
    expect(secrets.length).toBeGreaterThan(10);
  });

  it.each(secrets)('lists %s', (name) => {
    expect(page).toContain(`\`${name}\``);
  });

  it('says how to rotate the key that has a dual-key procedure, with the commands that do it', () => {
    expect(page).toContain('AUTH_SECRET_PREVIOUS');
    expect(page).toContain('pnpm auth:rotate-keys --dry-run');
    expect(page).toContain('pnpm auth:rotate-keys`');
  });

  it('contains no value that looks like a real secret', () => {
    // Prose and placeholders only: a private key block or a long unbroken random string would be a leak.
    expect(page).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(page).not.toMatch(/\b[A-Za-z0-9+/]{40,}={0,2}\b/);
  });
});
