import { afterEach, describe, expect, inject, it } from 'vitest';
import { loadApiEnv, type ApiEnv } from '../config/env.js';
import { DatabaseService } from './database.service.js';

/**
 * The API refuses to run as a database role that can bypass row-level security (CLAUDE.md §5.1,
 * ADR-0042).
 *
 * Managed Postgres hands out an administrative role as its first connection string, and that role
 * bypasses RLS: every tenant's rows, no error, no log line. So in production the service asks the
 * database what its roles are before the API listens. Against a real Postgres, as the real roles,
 * with the superuser standing in for the administrative one.
 */
const services: DatabaseService[] = [];

function serviceFor(nodeEnv: ApiEnv['NODE_ENV'], urls: { app: string; auth: string }) {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    DATABASE_AUTH_URL: urls.auth,
    DATABASE_POOL_MAX: '4',
    AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
  });
  // loadApiEnv would (rightly) refuse these development values under NODE_ENV=production, so the
  // production behaviour is selected after the environment has been validated as a test one.
  const service = new DatabaseService({ ...env, NODE_ENV: nodeEnv });
  services.push(service);
  return service;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
});

describe('DatabaseService startup in production', () => {
  it('starts with the roles the bootstrap builds', async () => {
    const { app, auth } = inject('dbUrls');
    await expect(serviceFor('production', { app, auth }).onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses when the application connection can bypass row-level security', async () => {
    const { auth, superuser } = inject('dbUrls');
    await expect(serviceFor('production', { app: superuser, auth }).onModuleInit()).rejects.toThrow(
      /Refusing to start: a database connection can bypass row-level security[\s\S]*DATABASE_URL connects as role "[^"]+", which is a superuser/,
    );
  });

  it('refuses when only the auth connection can, and says which one', async () => {
    const { app, superuser } = inject('dbUrls');
    const attempt = serviceFor('production', { app, auth: superuser }).onModuleInit();
    await expect(attempt).rejects.toThrow(/DATABASE_AUTH_URL connects as role/);
    await expect(attempt).rejects.not.toThrow(/DATABASE_URL connects as role/);
  });

  it('is not asked outside production, where the roles are the ones the bootstrap built', async () => {
    const { auth, superuser } = inject('dbUrls');
    await expect(
      serviceFor('test', { app: superuser, auth }).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
