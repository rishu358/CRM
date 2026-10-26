import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { SearchTimeoutError } from '@crm/core';
import { createDbClient, withTenant, type DbClient } from '../client.js';
import { Fixtures } from '../testing/fixtures.js';
import { withSearchTimeout } from './timeout.js';

/**
 * The time limit on a search (ADR-0041 §1): a slow search is refused, and refusing it must not break
 * the transaction the request is running in, which holds the tenant for row-level security and has
 * more to do.
 */
let client: DbClient;
let superuser: pg.Pool;
let tenantId: string;

beforeAll(async () => {
  const urls = inject('dbUrls');
  client = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 1 });
  tenantId = (await new Fixtures(superuser).createTenant({ name: 'Search timeout' })).tenantId;
});

afterAll(async () => {
  await client.close();
  await superuser.end();
});

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(client.db, { tenantId, userId: null }, fn);

async function setting(tx: Parameters<typeof withSearchTimeout>[0], name: string): Promise<string> {
  const result = await tx.execute(sql`select current_setting(${name}, true) as value`);
  return String((result.rows[0] as { value: string }).value);
}

describe('a search under a time limit', () => {
  it('returns what it computed when it finishes in time', async () => {
    const value = await inTenant((tx) =>
      withSearchTimeout(tx, 2000, async (inner) => {
        const result = await inner.execute(sql`select 42 as answer`);
        return (result.rows[0] as { answer: number }).answer;
      }),
    );
    expect(value).toBe(42);
  });

  it('refuses a search that runs past the limit, as a SearchTimeoutError', async () => {
    const started = performance.now();
    await expect(
      inTenant((tx) =>
        withSearchTimeout(tx, 100, (inner) => inner.execute(sql`select pg_sleep(5)`)),
      ),
    ).rejects.toBeInstanceOf(SearchTimeoutError);
    // It stopped at the limit, not after the five seconds the statement wanted.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('says it as an error a client can act on: 503, a stable code, no driver detail', async () => {
    const error = await inTenant((tx) =>
      withSearchTimeout(tx, 100, (inner) => inner.execute(sql`select pg_sleep(5)`)),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchTimeoutError);
    const timeout = error as SearchTimeoutError;
    expect(timeout.httpStatus).toBe(503);
    expect(timeout.code).toBe('SEARCH_TIMEOUT');
    expect(timeout.message).not.toMatch(/postgres|statement|pg_sleep|cancel/i);
  });

  it('leaves the caller’s transaction usable, with its tenant, after a timeout', async () => {
    await inTenant(async (tx) => {
      const before = await setting(tx, 'app.tenant_id');
      await expect(
        withSearchTimeout(tx, 100, (inner) => inner.execute(sql`select pg_sleep(5)`)),
      ).rejects.toBeInstanceOf(SearchTimeoutError);

      // Without the savepoint this is "current transaction is aborted".
      expect(await setting(tx, 'app.tenant_id')).toBe(before);
      expect(before).toBe(tenantId);
      await tx.execute(sql`select 1`);
    });
  });

  it('does not leave its limit behind: the caller’s own statements keep the limit they had', async () => {
    await inTenant(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '30s', true)`);
      await withSearchTimeout(tx, 500, (inner) => inner.execute(sql`select 1`));
      expect(await setting(tx, 'statement_timeout')).toBe('30s');
    });
    await inTenant(async (tx) => {
      const before = await setting(tx, 'statement_timeout');
      await withSearchTimeout(tx, 500, (inner) => inner.execute(sql`select 1`));
      expect(await setting(tx, 'statement_timeout')).toBe(before);
    });
  });

  it('lets any other error through untouched', async () => {
    const error = await inTenant((tx) =>
      withSearchTimeout(tx, 2000, (inner) => inner.execute(sql`select 1 / 0`)),
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SearchTimeoutError);
    expect(error).toBeInstanceOf(Error);
  });
});
