import { newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';

/**
 * A check writes nothing and says what an import would do (ADR-0068, CLAUDE.md §10).
 *
 * The check is the one import path that must never leave a record, an audit entry about a record or
 * an event behind, and must still report the truth, because the person decides whether to import on
 * what it says. These tests run the same file both ways and compare.
 */
let h: WorkerHarness;
let owner: string;

const unique = (): string => newId().replaceAll('-', '').slice(-10);

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Import Check' });
  owner = await h.user('Owner');
});

afterAll(async () => {
  await h.close();
});

const MAP = [
  { column: 0, field: 'last_name' },
  { column: 1, field: 'email' },
  { column: 2, field: 'title' },
];

const HEAD = ['Last', 'Email', 'Title'];

const counts = (job: {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
}) => ({
  createdCount: job.createdCount,
  updatedCount: job.updatedCount,
  skippedCount: job.skippedCount,
  failedCount: job.failedCount,
});

async function rowsWithTag(tag: string): Promise<number> {
  const result = await h.pool.query(
    `select count(*)::int as n from contacts where tenant_id = $1 and email::text like $2`,
    [h.tenantId, `%${tag}%`],
  );
  return Number(result.rows[0]?.['n']);
}

async function writtenFor(tenantId: string): Promise<{ audit: number; events: number }> {
  const audit = await h.pool.query(
    `select count(*)::int as n from audit_logs where tenant_id = $1 and object_type = 'contact'`,
    [tenantId],
  );
  const events = await h.pool.query(
    `select count(*)::int as n from outbox_events where tenant_id = $1 and object_type = 'contact'`,
    [tenantId],
  );
  return { audit: Number(audit.rows[0]?.['n']), events: Number(events.rows[0]?.['n']) };
}

describe('a check', () => {
  it('writes no record, no audit entry and no event, and still reports what would happen', async () => {
    const tag = unique();
    const existing = await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'Existing',
      email: `existing-${tag}@x.io`,
    });
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([
        HEAD,
        ['New One', `one-${tag}@x.io`, 'CEO'],
        ['New Two', `two-${tag}@x.io`, 'CTO'],
        ['Existing', `existing-${tag}@x.io`, 'VP'],
        ['Broken', 'not-an-email', 'x'],
      ]),
    });
    const before = await writtenFor(h.tenantId);

    const checkId = await h.check(analyzed.id, {
      mapping: MAP,
      duplicateMode: 'update',
      matchField: 'email',
    });
    await h.drain();

    const check = await h.job(checkId);
    expect(check).toMatchObject({
      status: 'completed',
      dryRun: true,
      createdCount: 2,
      updatedCount: 1,
      failedCount: 1,
    });

    // Nothing was written: no new record, the existing one untouched, no audit entry, no event.
    expect(await rowsWithTag(tag)).toBe(1);
    expect(
      (await h.pool.query('select title, version from contacts where id = $1', [existing])).rows[0],
    ).toMatchObject({ title: null, version: 1 });
    expect(await writtenFor(h.tenantId)).toEqual(before);

    // It says which row would fail, in a file of its own.
    expect(check.errorFileKey).toMatch(/\.check\.errors\.csv$/);
    expect(h.readText(check.errorFileKey as string)).toContain('not-an-email');

    // The job being checked is untouched and still waiting for its mapping.
    expect((await h.job(analyzed.id)).status).toBe('awaiting_mapping');
  });

  it('reports exactly what the real import then does', async () => {
    const tag = unique();
    await h.fixtures.createContact(h.tenantId, {
      ownerId: owner,
      lastName: 'Existing',
      email: `same-${tag}@x.io`,
    });
    const file = csv([
      HEAD,
      ['A', `a-${tag}@x.io`, 'x'],
      ['B', `b-${tag}@x.io`, 'x'],
      ['Existing', `same-${tag}@x.io`, 'x'],
      ['Bad', 'nope', 'x'],
    ]);
    const analyzed = await h.analyze({ userId: owner, bytes: file });
    const options = { mapping: MAP, duplicateMode: 'skip' as const, matchField: 'email' };

    const checkId = await h.check(analyzed.id, options);
    await h.drain();
    const check = await h.job(checkId);

    await h.start(analyzed.id, options);
    await h.drain();
    const real = await h.job(analyzed.id);

    expect(real.status).toBe('completed');
    expect(counts(check)).toEqual(counts(real));
    expect(counts(real)).toEqual({
      createdCount: 2,
      updatedCount: 0,
      skippedCount: 1,
      failedCount: 1,
    });
  });

  it('can be run again, and does not use up the file: the import still runs afterwards', async () => {
    const tag = unique();
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([HEAD, ['A', `again-${tag}@x.io`, 'x']]),
    });
    for (let i = 0; i < 2; i += 1) {
      const checkId = await h.check(analyzed.id, { mapping: MAP });
      await h.drain();
      expect((await h.job(checkId)).status).toBe('completed');
    }
    expect(h.storage.has((await h.job(analyzed.id)).storageKey)).toBe(true);

    await h.start(analyzed.id, { mapping: MAP });
    await h.drain();
    expect(await h.job(analyzed.id)).toMatchObject({ status: 'completed', createdCount: 1 });
    expect(await rowsWithTag(tag)).toBe(1);
  });

  it('counts rows in "create anyway" mode as new, and still leaves nothing behind', async () => {
    const tag = unique();
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([HEAD, ['Dup', `dup-${tag}@x.io`, 'x'], ['Dup Again', `dup-${tag}@x.io`, 'x']]),
    });
    // Two rows with one e-mail in "create anyway" mode are two records, which the real import allows.
    const checkId = await h.check(analyzed.id, { mapping: MAP, duplicateMode: 'create' });
    await h.drain();
    expect(await h.job(checkId)).toMatchObject({ createdCount: 2, failedCount: 0 });
    expect(await rowsWithTag(tag)).toBe(0);
  });

  it('never deletes the file when it fails, so the import it belongs to can still run', async () => {
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([HEAD, ['A', `fail-${unique()}@x.io`, 'x']]),
    });
    // A hostile mapping is refused by the worker at the first chunk and the check ends as failed.
    const checkId = await h.check(analyzed.id, {
      mapping: [
        { column: 0, field: 'last_name' },
        { column: 1, field: 'tenant_id' },
      ],
    });
    await h.drain();
    expect((await h.job(checkId)).status).toBe('failed');
    expect(h.storage.has((await h.job(analyzed.id)).storageKey)).toBe(true);
  });
});

describe('a check is held to the same rules as an import', () => {
  it('cannot be turned into a real import, or a real import into a check, in place', async () => {
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([HEAD, ['A', `flip-${unique()}@x.io`, 'x']]),
    });
    const checkId = await h.check(analyzed.id, { mapping: MAP });
    await expect(
      h.pool.query('update import_jobs set dry_run = false where id = $1', [checkId]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      h.pool.query('update import_jobs set dry_run = true where id = $1', [analyzed.id]),
    ).rejects.toThrow(/identity is immutable/);
  });

  it('is private to the workspace: another workspace cannot see it', async () => {
    const other = (await h.fixtures.createTenant({ name: 'Check Other' })).tenantId;
    const analyzed = await h.analyze({
      userId: owner,
      bytes: csv([HEAD, ['A', `iso-${unique()}@x.io`, 'x']]),
    });
    const checkId = await h.check(analyzed.id, { mapping: MAP });
    await h.drain();
    const visible = await h.pool.query(
      `select count(*)::int as n from import_jobs where id = $1 and tenant_id = $2`,
      [checkId, other],
    );
    expect(visible.rows[0]?.['n']).toBe(0);
  });
});
