import { describe, expect, it } from 'vitest';
import { allVariables, EnvError, loadEnv, variablesFor } from './load.js';
import { GROUPS, LOADABLE_SCOPES, type LoadableScope } from './types.js';

/**
 * Invariants of the registry as a whole. The registry is the one place configuration is declared
 * (ADR-0044), and these are what make that safe to rely on: the generated documentation says what
 * the loaders do, and the web app can never be handed a credential, because they are tested here
 * across every variable rather than hoped for.
 */

/** The names a scope reports as missing when nothing at all is set. */
function missingFor(scope: LoadableScope): string[] {
  try {
    loadEnv(scope, {});
    return [];
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return error.problems.map(
      (problem) => /^([A-Z0-9_]+) is not set/.exec(problem)?.[1] ?? problem,
    );
  }
}

describe('the registry', () => {
  const all = allVariables();

  it('declares each variable once, with a conventional name and a description', () => {
    const names = all.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, def] of all) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(def.description.trim().length, `${name} needs a description`).toBeGreaterThan(10);
      expect(def.scopes.length, `${name} must list a scope`).toBeGreaterThan(0);
      expect(
        GROUPS.map((group) => group.id),
        name,
      ).toContain(def.group);
    }
  });

  it('never gives the web app a secret', () => {
    // The web app runs on another platform and has no business holding a credential (CLAUDE.md §3).
    const secretsInWeb = variablesFor('web')
      .filter(([, def]) => def.secret)
      .map(([name]) => name);
    expect(secretsInWeb).toEqual([]);
  });

  it('never gives the web app a database variable', () => {
    const databaseInWeb = variablesFor('web')
      .filter(([name]) => name.startsWith('DATABASE_'))
      .map(([name]) => name);
    expect(databaseInWeb).toEqual([]);
  });

  it('marks every credential secret', () => {
    // A credential not marked secret would be printed in logs and written into the docs.
    const credential = /(SECRET|PASSWORD|API_KEY|ACCESS_KEY)/;
    const credentialUrl = /^(DATABASE|REDIS|PERF_ADMIN)_.*URL$/;
    for (const [name, def] of all) {
      if (credential.test(name) || credentialUrl.test(name)) {
        expect(def.secret, `${name} should be marked secret`).toBe(true);
      }
    }
    // The named list, as a backstop against the patterns above going stale.
    for (const name of [
      'AUTH_SECRET',
      'DATABASE_URL',
      'DATABASE_AUTH_URL',
      'DATABASE_WORKER_URL',
      'DATABASE_ERASURE_URL',
      'DATABASE_MIGRATION_URL',
      'RESEND_API_KEY',
      'SES_ACCESS_KEY_ID',
      'SES_SECRET_ACCESS_KEY',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'GOOGLE_CLIENT_SECRET',
      'REDIS_URL',
      'PERF_ADMIN_URL',
    ]) {
      expect(all.find(([candidate]) => candidate === name)?.[1].secret, name).toBe(true);
    }
  });

  describe.each(LOADABLE_SCOPES)('scope %s', (scope) => {
    it('documents as required exactly what the loader requires', () => {
      const documented = variablesFor(scope)
        .filter(([, def]) => def.requirement === 'required')
        .map(([name]) => name)
        .sort();
      expect(missingFor(scope).sort()).toEqual(documented);
    });

    it('documents each default as the value the loader applies', () => {
      // Required variables have no default; give them a value so the loader can run at all.
      const source: Record<string, string> = {};
      for (const [name, def] of variablesFor(scope)) {
        if (def.requirement === 'required') source[name] = def.local ?? 'x'.repeat(40);
      }
      const loaded = loadEnv(scope, source) as Record<string, unknown>;
      for (const [name, def] of variablesFor(scope)) {
        const documented = def.defaultFor(scope);
        if (documented === undefined) continue;
        expect(String(loaded[name]), `${name} (${scope})`).toBe(documented);
      }
    });

    it('loads from the local example values alone', () => {
      // `.env.example` is generated from these `local` values; it must be a working configuration.
      const source: Record<string, string> = {};
      for (const [name, def] of variablesFor(scope)) {
        const value = def.local ?? def.defaultFor(scope);
        if (value !== undefined && value !== '') source[name] = value;
      }
      expect(() => loadEnv(scope, source)).not.toThrow();
    });
  });
});
