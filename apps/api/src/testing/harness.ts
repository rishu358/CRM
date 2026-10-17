import { createDbClient, withTenant, type DbClient } from '@crm/db';
import { Fixtures, type TestDbUrls } from '@crm/db/testing';
import { provisionTenantDefaults } from '@crm/db/seed';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { createApp } from '../bootstrap.js';
import { loadApiEnv, type ApiEnv } from '../config/env.js';
import { SessionService } from '../auth/session.service.js';
import { EMAIL_PROVIDER, type MemoryEmailProvider } from '../platform/email/email.provider.js';

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
  /**
   * The mail the app has sent.
   *
   * Verification and reset tokens exist only in the email — the database
   * stores their hashes — so this is how a test follows the same path a user
   * does, rather than asserting on our storage.
   */
  readonly emails: MemoryEmailProvider;
  close(): Promise<void>;
}

/**
 * Pull the one-time token out of a link in an email body.
 *
 * The character class includes `.` because an invitation token carries its
 * workspace id as a dotted prefix (ADR-0018); every other token here is plain
 * base64url.
 */
export function tokenFromEmail(body: string): string {
  const match = /[?&]token=([A-Za-z0-9._-]+)/.exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`No token in email body:
${body}`);
  }
  return match[1];
}

/**
 * @param overrides environment values for a test that needs different limits
 *   or providers than the shared defaults below.
 */
export async function startApiHarness(
  urls: TestDbUrls,
  overrides: Record<string, string> = {},
): Promise<ApiHarness> {
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
    // The suite makes hundreds of sign-in attempts from one address, which a
    // production-sized auth limit would rightly refuse. The limit itself is
    // covered by its own test, which sets a small ceiling deliberately.
    AUTH_RATE_LIMIT_MAX_PER_IP: '100000',
    // Mail is captured rather than printed, so a test can read the token out
    // of the message the same way a user reads it out of their inbox.
    EMAIL_PROVIDER: 'memory',
    // The throttle still engages and is still asserted on; what is shortened
    // is only how long the suite waits for it. Setting it to zero would let a
    // regression that removed the delay entirely pass unnoticed.
    AUTH_THROTTLE_MAX_DELAY_MS: '50',
    ...overrides,
  });

  const app = await createApp(env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  const appClient: DbClient = createDbClient({ connectionString: urls.app, maxConnections: 4 });
  const sessions = app.get(SessionService);
  const emails = app.get<MemoryEmailProvider>(EMAIL_PROVIDER);

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
    emails,
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
