import { afterAll, inject } from 'vitest';
import pg from 'pg';
import type { Uuid } from '@crm/core';
import { describeSearchProviderContract } from '@crm/core/search-contract';
import { createDbClient, withTenant, type DbClient } from '../client.js';
import { Fixtures } from '../testing/fixtures.js';
import { PostgresSearchProvider } from './postgres.js';

/**
 * The Postgres provider against the contract every `SearchProvider` must satisfy
 * (`packages/core/src/search/provider-contract.ts`).
 *
 * A Meilisearch provider is acceptable when a file shaped exactly like this one, handing the same suite
 * its own harness, passes. It runs as `crm_worker` (the role that may write `search_documents`) inside
 * a tenant-scoped transaction, so row-level security applies here exactly as it does in production.
 */
let worker: DbClient | undefined;
let superuser: pg.Pool | undefined;

describeSearchProviderContract('Postgres', () => {
  const urls = inject('dbUrls');
  const client = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  const pool = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  worker = client;
  superuser = pool;
  const fixtures = new Fixtures(pool);
  return Promise.resolve({
    provider: new PostgresSearchProvider(),
    within: (tenantId, fn) => withTenant(client.db, { tenantId, userId: null }, fn),
    newTenant: async () =>
      (await fixtures.createTenant({ name: 'Search contract' })).tenantId as Uuid,
  });
});

afterAll(async () => {
  await worker?.close();
  await superuser?.end();
});
