import { createDbClient, withTenant, type DbClient } from '@crm/db';
import { Fixtures, type TestDbUrls } from '@crm/db/testing';
import { provisionTenantDefaults } from '@crm/db/seed';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { createApp } from '../bootstrap.js';
import { loadApiEnv, type ApiEnv } from '../config/env.js';
import { SessionService } from '../auth/session.service.js';

/**
 * Boots the real application against the test database.
 *
 * Deliberately not a simplified test app: the guards, the global filter, the
 * validation pipes and the role split are all the production ones, because the
 * things these tests are checking — 401s, field stripping, tenant isolation —
 * all live in exactly those layers.
 */
export interface ApiHarness {
  readonly app: NestFastifyApplication;
  readonly fixtures: Fixtures;
  readonly env: ApiEnv;
  /** Provision a tenant with the default roles and field metadata. */
  provision(tenantId: string): Promise<ReadonlyMap<string, string>>;
  /** Issue a real session and return its bearer token. */
  signIn(userId: string, tenantId: string): Promise<string>;
  close(): Promise<void>;
}

export async function startApiHarness(urls: TestDbUrls): Promise<ApiHarness> {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    DATABASE_AUTH_URL: urls.auth,
    DATABASE_POOL_MAX: '8',
    AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
    LOG_LEVEL: 'error',
    // High enough that the suite's own traffic never trips the limiter and
    // turns a permission assertion into a confusing 429.
    RATE_LIMIT_MAX_PER_USER: '100000',
  });

  const app = await createApp(env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  const appClient: DbClient = createDbClient({ connectionString: urls.app, maxConnections: 4 });
  const sessions = app.get(SessionService);

  return {
    app,
    env,
    fixtures: new Fixtures(superuserPool),
    provision: async (tenantId: string) => {
      const result = await withTenant(appClient.db, { tenantId, userId: null }, (tx) =>
        provisionTenantDefaults(tx, tenantId, null),
      );
      return result.roleIdsByName;
    },
    signIn: async (userId: string, tenantId: string) => {
      const { token } = await sessions.issue(userId, { tenantId });
      return token;
    },
    close: async () => {
      await app.close();
      await Promise.all([superuserPool.end(), appClient.close()]);
    },
  };
}

/** Send a request through the real HTTP stack, including guards and filters. */
export async function request(
  harness: ApiHarness,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    token?: string | undefined;
    tenantId?: string | undefined;
    body?: unknown;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  // Only declare a JSON body when there is one: Fastify rejects a request that
  // announces application/json and then sends nothing, which would turn every
  // bodyless DELETE into a 400 before the guard ever runs.
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.tenantId !== undefined) headers['x-tenant-id'] = options.tenantId;

  const response = await harness.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });

  let body: Record<string, unknown> = {};
  if (response.payload.length > 0) {
    try {
      body = JSON.parse(response.payload) as Record<string, unknown>;
    } catch {
      body = { raw: response.payload };
    }
  }
  return { status: response.statusCode, body };
}
