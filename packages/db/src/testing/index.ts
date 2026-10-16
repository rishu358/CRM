import pg from 'pg';
import { createDbClient, type DbClient } from '../client.js';
import { Fixtures } from './fixtures.js';

export { captureDbError, INSUFFICIENT_PRIVILEGE } from './errors.js';
export type { CapturedDbError } from './errors.js';
export { Fixtures } from './fixtures.js';
export type { SeededTenant, SeededUser } from './fixtures.js';
export type { TestDbUrls } from './global-setup.js';

/**
 * Connections for a test file.
 *
 * Each role the application uses gets its own client, so a test can assert what
 * a given role can and cannot do — which is the only way to verify that the
 * grants and policies in migration 0004 actually say what they are meant to.
 */
export interface TestDatabase {
  /** The API's role: tenant-scoped, no BYPASSRLS. */
  readonly app: DbClient;
  /** The auth layer's role: identity tables only. */
  readonly auth: DbClient;
  /** The outbox relay's role: tenant-scoped plus cross-tenant outbox. */
  readonly worker: DbClient;
  /** Superuser pool, used only to seed fixtures from outside the RLS boundary. */
  readonly fixtures: Fixtures;
  close(): Promise<void>;
}

export function createTestDatabase(urls: {
  app: string;
  auth: string;
  worker: string;
  superuser: string;
}): TestDatabase {
  const app = createDbClient({ connectionString: urls.app, maxConnections: 5 });
  const auth = createDbClient({ connectionString: urls.auth, maxConnections: 2 });
  const worker = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  const superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });

  return {
    app,
    auth,
    worker,
    fixtures: new Fixtures(superuserPool),
    close: async () => {
      await Promise.all([app.close(), auth.close(), worker.close(), superuserPool.end()]);
    },
  };
}
