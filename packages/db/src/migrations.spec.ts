import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRootFrom } from './package-root.js';

/**
 * Guards on the migration filenames themselves.
 *
 * Modules are built in parallel worktrees, and a branch cannot see the numbers
 * another branch is using. Accounts and invitations both picked `0007`, and the
 * two applied in the right order only because the lexical sort of their names
 * happened to match the order they were needed in. That is luck, not design,
 * and the next collision may not be so lucky.
 *
 * Renaming an applied migration is not the fix: the runner keys on filename, so
 * a rename makes an applied migration look new and it is attempted again
 * against a schema that already has it. The two 0007 files therefore stay as
 * they are, recorded below, and this test stops a *third* from joining them.
 */
const MIGRATIONS_DIR = join(packageRootFrom(import.meta.url), 'migrations');

/**
 * The one collision that predates this test. It is applied in every
 * environment and cannot be renumbered, only lived with.
 */
const KNOWN_COLLISIONS: ReadonlySet<string> = new Set(['0007']);

/**
 * Numbers handed to branches that have not merged yet.
 *
 * The numbers are assigned centrally for exactly the reason the collision above
 * happened, which means a branch can legitimately hold 0016 while 0013 to 0015
 * are still in flight elsewhere. The gap check below would otherwise fail every
 * such branch, and the usual response to that — renumber — reintroduces the
 * collision this file exists to prevent.
 *
 * It is self-cleaning: the test also asserts that each reserved number is still
 * **absent**, so the day 0013 lands this list fails until its line is deleted.
 * A reservation therefore cannot quietly become a permanent hole.
 */
const RESERVED_NUMBERS: ReadonlySet<number> = new Set([]);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

describe('migration filenames', () => {
  it('uses the NNNN_name.sql shape', () => {
    for (const name of migrationFiles()) {
      expect(name, `${name} should look like 0001_description.sql`).toMatch(
        /^\d{4}_[a-z0-9_]+\.sql$/,
      );
    }
  });

  it('does not add a new duplicate number', () => {
    const byNumber = new Map<string, string[]>();
    for (const name of migrationFiles()) {
      const number = name.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const duplicates = [...byNumber.entries()]
      .filter(([number, files]) => files.length > 1 && !KNOWN_COLLISIONS.has(number))
      .map(([number, files]) => `${number}: ${files.join(', ')}`);

    expect(
      duplicates,
      'Two migrations share a number. Pick the next free one — order then depends ' +
        'on a lexical sort of the filenames, which is not something to rely on.',
    ).toEqual([]);
  });

  it('leaves no gap in the sequence', () => {
    // A gap usually means a migration was deleted rather than superseded, which
    // leaves environments that already applied it permanently out of step. A
    // number reserved by a branch still in flight is the one benign exception.
    const numbers = [...new Set(migrationFiles().map((name) => Number(name.slice(0, 4))))].sort(
      (a, b) => a - b,
    );

    expect(numbers[0]).toBe(1);

    const last = numbers[numbers.length - 1] ?? 0;
    const missing: number[] = [];
    for (let n = 1; n <= last; n += 1) {
      if (!numbers.includes(n) && !RESERVED_NUMBERS.has(n)) missing.push(n);
    }

    expect(missing, `gap before migration ${missing[0] ?? ''}`).toEqual([]);
  });

  it('has no reservation for a number that has since landed', () => {
    const present = new Set(migrationFiles().map((name) => Number(name.slice(0, 4))));
    const landed = [...RESERVED_NUMBERS].filter((number) => present.has(number));

    expect(
      landed,
      'A reserved migration number now exists. Remove it from RESERVED_NUMBERS so ' +
        'the gap check covers it again.',
    ).toEqual([]);
  });
});
