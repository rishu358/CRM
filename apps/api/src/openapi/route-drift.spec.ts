import { API_ROUTES, routeKey } from '@crm/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../bootstrap.js';
import { loadApiEnv } from '../config/env.js';

/**
 * The route registry cannot rot.
 *
 * `packages/contracts/src/routes.ts` is hand-maintained, and a hand-maintained
 * list of endpoints goes stale the first time somebody is in a hurry. When it
 * does, ADR-0007's promise — that the mobile app, the public API and Zapier
 * reuse exactly the surface the web app uses — quietly stops being true,
 * because the only published description of that surface no longer matches it.
 *
 * So the registry is not checked by discipline. This file boots the real
 * application, collects the routes Fastify has actually registered, and fails
 * when the two disagree **in either direction**: an endpoint with no entry, or
 * an entry with no endpoint. The generated document is a by-product of that
 * agreement.
 *
 * Collection happens through Fastify's `onRoute` hook rather than by reading
 * Nest's metadata, because the hook sees what will actually be served —
 * including the global `/api/v1` prefix, and including anything registered by
 * a plugin rather than by a controller.
 */

/** A route as Fastify will serve it, normalised to how the registry spells it. */
interface RealRoute {
  readonly method: string;
  readonly path: string;
}

const PREFIX = '/api/v1';

/**
 * Methods Fastify adds on its own behalf.
 *
 * `HEAD` is registered automatically alongside every `GET`, and `OPTIONS` by
 * CORS. Neither is an endpoint anybody writes or documents.
 */
const IMPLICIT_METHODS = new Set(['HEAD', 'OPTIONS']);

/** `/api/v1/contacts/:id` → `/contacts/{id}`. */
function normalise(url: string): string {
  const withoutPrefix = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
  const path = withoutPrefix.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  // Fastify's root is '/', which the registry would spell as ''.
  return path === '' ? '/' : path;
}

let app: NestFastifyApplication;
let realRoutes: RealRoute[];

beforeAll(async () => {
  const urls = inject('dbUrls');
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    DATABASE_AUTH_URL: urls.auth,
    DATABASE_POOL_MAX: '2',
    AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
    LOG_LEVEL: 'error',
  });

  // `createApp` returns before Nest registers its routes, which is the only
  // window in which an `onRoute` hook can see all of them.
  app = await createApp(env);
  const collected: RealRoute[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (IMPLICIT_METHODS.has(method)) continue;
        collected.push({ method, path: normalise(route.url) });
      }
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  realRoutes = collected;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('route registry', () => {
  it('collects the real routes', () => {
    // A guard on the guard: if `onRoute` ever stops firing, every other
    // assertion here would pass vacuously by finding nothing to disagree with.
    expect(realRoutes.length).toBeGreaterThan(50);
  });

  it('has an entry for every route the API serves', () => {
    const documented = new Set(API_ROUTES.map((route) => routeKey(route.method, route.path)));
    const undocumented = realRoutes
      .map((route) => routeKey(route.method, route.path))
      .filter((key) => !documented.has(key))
      .sort();

    expect(
      undocumented,
      'These endpoints exist but are not in packages/contracts/src/routes.ts. ' +
        'Add an entry and run `pnpm openapi:generate`.',
    ).toEqual([]);
  });

  it('has no entry for a route the API does not serve', () => {
    const real = new Set(realRoutes.map((route) => routeKey(route.method, route.path)));
    const phantom = API_ROUTES.map((route) => routeKey(route.method, route.path))
      .filter((key) => !real.has(key))
      .sort();

    expect(
      phantom,
      'These are in packages/contracts/src/routes.ts but the API serves nothing at them. ' +
        'Remove the entry and run `pnpm openapi:generate`.',
    ).toEqual([]);
  });

  it('serves the generated document', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/api/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document = JSON.parse(response.payload) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.openapi).toBe('3.1.0');

    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => routeKey(method, path)),
    );
    expect(operations.sort()).toEqual(
      API_ROUTES.map((route) => routeKey(route.method, route.path)).sort(),
    );
  });

  it('reaches the document without a session', async () => {
    // The one thing about this endpoint that is a security decision: it is
    // public on purpose (ADR-0027), so a regression that quietly put it behind
    // the guard — or a change that made it leak more than the contracts do —
    // should be a deliberate edit to this test, not a silent drift.
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/api/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain('DATABASE_URL');
    expect(response.payload).not.toContain('AUTH_SECRET');
  });
});
