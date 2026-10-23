import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { packageRootFrom } from './package-root.js';

/**
 * A database without a superuser must still be able to run the product (ADR-0041 §1).
 *
 * The bootstrap script marks two search functions LEAKPROOF, which only a superuser can do. On most
 * managed Postgres services the customer has none, so a bootstrap that aborted at that statement
 * would make those services unusable. The statements are therefore wrapped: a missing privilege is a
 * warning, and everything after it still runs. This executes that very block, extracted from the
 * script, as a role that is not a superuser, and demands it neither throws nor changes the marks.
 */
let superuser: pg.Pool;
let asUnprivileged: pg.Client;

/** The `DO` block that applies the marks, taken from the script so the test cannot drift from it. */
function leakproofBlock(): string {
  const file = join(packageRootFrom(import.meta.url), 'sql/bootstrap/01-extensions-and-roles.sql');
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('DO $$\nBEGIN\n  ALTER FUNCTION ts_match_vq');
  const end = sql.indexOf('$$;', start);
  if (start < 0 || end < 0)
    throw new Error('The LEAKPROOF block is not where this test expects it');
  return sql.slice(start, end + 3);
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 1 });
  // `crm_migrator` is the least privileged role the bootstrap's own text names, and not a superuser.
  asUnprivileged = new pg.Client({ connectionString: urls.migrator });
  await asUnprivileged.connect();
});

afterAll(async () => {
  await asUnprivileged.end();
  await superuser.end();
});

describe('the bootstrap on a database without a superuser', () => {
  it('runs as a role that is not a superuser', async () => {
    const result = await asUnprivileged.query<{ rolsuper: boolean }>(
      'select rolsuper from pg_roles where rolname = current_user',
    );
    expect(result.rows[0]?.rolsuper).toBe(false);
  });

  it('warns and carries on when it may not mark the functions leakproof', async () => {
    const notices: string[] = [];
    asUnprivileged.on('notice', (notice) => notices.push(notice.message ?? ''));

    await expect(asUnprivileged.query(leakproofBlock())).resolves.toBeDefined();
    expect(notices.join(' ')).toContain('Could not mark ts_match_vq');
    expect(notices.join(' ')).toContain('RUNBOOK');
  });

  it('leaves the marks as they were: it does not pretend, and does not undo them', async () => {
    const before = await superuser.query<{ proname: string; proleakproof: boolean }>(
      `select proname, proleakproof from pg_proc
       where proname in ('ts_match_vq', 'word_similarity_op') order by proname`,
    );
    await asUnprivileged.query(leakproofBlock());
    const after = await superuser.query<{ proname: string; proleakproof: boolean }>(
      `select proname, proleakproof from pg_proc
       where proname in ('ts_match_vq', 'word_similarity_op') order by proname`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('is still the same statement a superuser runs, and it succeeds there and marks both', async () => {
    await superuser.query(leakproofBlock());
    const result = await superuser.query<{ proleakproof: boolean }>(
      `select proleakproof from pg_proc where proname in ('ts_match_vq', 'word_similarity_op')`,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.proleakproof)).toBe(true);
  });
});
