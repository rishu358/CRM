import { describe, expect, it } from 'vitest';
import {
  assertProductionConfig,
  productionConfigProblems,
  type ProductionConfigInput,
} from './production.js';

/** A configuration a real deployment could be running: every field good. */
const GOOD: ProductionConfigInput = {
  nodeEnv: 'production',
  authSecret: 'q8Zr3vXk1LmN7pTc0YbUe5HwJd2GfAoS9iRtVxCz4KuBn6MyPqEl',
  emailProvider: 'resend',
  emailFrom: 'CRM <no-reply@mail.acme-crm.io>',
  resendApiKey: 're_live_abcdefghijklmnop',
  storageProvider: 's3',
  s3AccessKeyId: 'AKIAEXAMPLE',
  s3SecretAccessKey: 'wJalrXUtnFEMI',
  s3PublicEndpoint: 'https://files.acme-crm.io',
  webUrl: 'https://app.acme-crm.io',
  apiUrl: 'https://api.acme-crm.io',
  corsOrigins: 'https://app.acme-crm.io',
  databaseUrls: {
    DATABASE_URL: 'postgres://crm_app:Zk3pQ8vLm2Xr@db.internal.acme:5432/crm',
    DATABASE_AUTH_URL: 'postgres://crm_auth:Hn7tW4cYb9Ud@db.internal.acme:5432/crm',
  },
  redisUrl: 'rediss://:Qm7vLk2Xt9WdRb4N@cache.internal.acme:6380',
};

const problemsOf = (change: Partial<ProductionConfigInput>) =>
  productionConfigProblems({ ...GOOD, ...change }).problems.join(' | ');

describe('production configuration', () => {
  it('accepts a configuration a real deployment could run', () => {
    expect(productionConfigProblems(GOOD)).toEqual({ problems: [], warnings: [] });
  });

  it('checks nothing outside production', () => {
    expect(
      productionConfigProblems({
        nodeEnv: 'development',
        authSecret: 'short',
        emailProvider: 'console',
      }),
    ).toEqual({ problems: [], warnings: [] });
    expect(productionConfigProblems({ nodeEnv: 'test' }).problems).toEqual([]);
  });

  it.each([
    [undefined, 'AUTH_SECRET is not set'],
    ['', 'AUTH_SECRET is not set'],
    ['short', 'at least 32'],
    ['dev-only-insecure-secret-change-me-before-any-real-use-0000', 'placeholder'],
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'too few distinct'],
    ['abababababababababababababababababababab', 'too few distinct'],
    ['Q8zr3VXk1lmn7ptc0ybue5hwjd2gfaos9irtvxcz4kubn6myPqEl-test', 'placeholder'],
  ])('refuses the session secret %j', (authSecret, expected) => {
    expect(problemsOf({ authSecret })).toContain(expected);
  });

  it('refuses mail that goes nowhere, and a provider it cannot send with', () => {
    expect(problemsOf({ emailProvider: 'console' })).toContain('EMAIL_PROVIDER=console');
    expect(problemsOf({ emailProvider: 'memory' })).toContain(
      'EMAIL_PROVIDER=memory delivers nothing',
    );
    expect(problemsOf({ emailProvider: undefined })).toContain('EMAIL_PROVIDER=console');
    expect(problemsOf({ emailProvider: 'smtp' })).toContain(
      'not a provider this build can send with',
    );
    expect(problemsOf({ resendApiKey: undefined })).toContain('requires RESEND_API_KEY');
    expect(problemsOf({ resendApiKey: '' })).toContain('requires RESEND_API_KEY');
  });

  it.each([undefined, '', 'no-reply', 'no-reply@localhost', 'CRM <no-reply@localhost>'])(
    'refuses the sender address %j',
    (emailFrom) => {
      expect(problemsOf({ emailFrom })).toContain('EMAIL_FROM');
    },
  );

  it('refuses storage that cannot work, and storage with no keys', () => {
    expect(problemsOf({ storageProvider: 'memory' })).toContain('STORAGE_PROVIDER=memory');
    expect(problemsOf({ s3AccessKeyId: undefined })).toContain('S3_ACCESS_KEY_ID');
    expect(problemsOf({ s3SecretAccessKey: '' })).toContain('S3_SECRET_ACCESS_KEY');
    expect(problemsOf({ s3PublicEndpoint: 'http://files.acme-crm.io' })).toContain(
      'S3_PUBLIC_ENDPOINT must be https',
    );
    expect(problemsOf({ s3PublicEndpoint: 'https://localhost:9000' })).toContain(
      'S3_PUBLIC_ENDPOINT points at this machine',
    );
    expect(problemsOf({ s3PublicEndpoint: undefined })).toBe('');
  });

  it.each([
    ['http://app.acme-crm.io', 'WEB_URL must be https'],
    ['https://localhost:3000', 'WEB_URL points at this machine'],
    ['https://127.0.0.1', 'WEB_URL points at this machine'],
    ['https://[::1]/', 'WEB_URL points at this machine'],
    ['https://0.0.0.0', 'WEB_URL points at this machine'],
    ['https://app.localhost', 'WEB_URL points at this machine'],
    ['not a url', 'WEB_URL is not a URL'],
    ['', 'WEB_URL is not set'],
  ])('refuses the web address %j', (webUrl, expected) => {
    expect(problemsOf({ webUrl })).toContain(expected);
  });

  it('applies the same rule to the API address', () => {
    expect(problemsOf({ apiUrl: 'http://api.acme-crm.io' })).toContain('API_URL must be https');
    expect(problemsOf({ apiUrl: undefined })).toContain('API_URL is not set');
  });

  it.each([
    ['*', 'must name origins, not *'],
    ['http://app.acme-crm.io', 'must be https origins'],
    ['https://app.acme-crm.io,http://localhost:3000', 'must be https origins'],
    ['nonsense', 'not an origin'],
    ['', 'CORS_ORIGINS is not set'],
  ])('refuses the CORS origins %j', (corsOrigins, expected) => {
    expect(problemsOf({ corsOrigins })).toContain(expected);
  });

  it('allows more than one real origin', () => {
    expect(problemsOf({ corsOrigins: 'https://app.acme-crm.io, https://admin.acme-crm.io' })).toBe(
      '',
    );
  });

  it.each([
    ['postgres://postgres:Zk3pQ8vLm2Xr@db.internal.acme:5432/crm', 'superuser'],
    ['postgres://root:Zk3pQ8vLm2Xr@db.internal.acme:5432/crm', 'superuser'],
    ['postgres://crm_app@db.internal.acme:5432/crm', 'no password'],
    ['postgres://crm_app:crm_app_dev@db.internal.acme:5432/crm', 'development password'],
    ['postgres://crm_app:changeme@db.internal.acme:5432/crm', 'development password'],
    ['postgres://crm_app:Zk3pQ8vLm2Xr@localhost:5432/crm', 'points at this machine'],
    ['not a connection string', 'not a connection string'],
  ])('refuses the database URL %j', (url, expected) => {
    expect(problemsOf({ databaseUrls: { DATABASE_URL: url } })).toContain(expected);
  });

  it('names the variable and never repeats its value', () => {
    const secret = 'dev-only-insecure-secret-change-me-before-any-real-use-0000';
    const dbPassword = 'crm_app_dev';
    const report = productionConfigProblems({
      ...GOOD,
      authSecret: secret,
      databaseUrls: { DATABASE_URL: `postgres://crm_app:${dbPassword}@localhost:5432/crm` },
    });
    const text = JSON.stringify(report);
    expect(text).toContain('AUTH_SECRET');
    expect(text).toContain('DATABASE_URL');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(dbPassword);
  });

  it('does not ask the worker for what only the API has', () => {
    const worker: ProductionConfigInput = {
      nodeEnv: 'production',
      scope: 'worker',
      emailProvider: 'resend',
      emailFrom: 'CRM <no-reply@mail.acme-crm.io>',
      resendApiKey: 're_live_abcdefghijklmnop',
      storageProvider: 's3',
      s3AccessKeyId: 'AKIAEXAMPLE',
      s3SecretAccessKey: 'wJalrXUtnFEMI',
      webUrl: 'https://app.acme-crm.io',
      databaseUrls: {
        DATABASE_URL: 'postgres://crm_worker:Hn7tW4cYb9Ud@db.internal.acme:5432/crm',
      },
      redisUrl: 'rediss://cache.internal.acme:6380',
    };
    expect(productionConfigProblems(worker)).toEqual({ problems: [], warnings: [] });
    // The worker serves no browser, so a CORS list is not its business, even a bad one.
    expect(productionConfigProblems({ ...worker, corsOrigins: '*' }).problems).toEqual([]);
    // It is still held to everything it does have.
    expect(
      productionConfigProblems({ ...worker, emailProvider: 'console' }).problems.join(),
    ).toContain('EMAIL_PROVIDER=console');
    expect(
      productionConfigProblems({ ...worker, webUrl: 'http://localhost:3000' }).problems.length,
    ).toBe(2);
  });

  it('reports every problem at once, so a deployment is fixed in one pass', () => {
    const report = productionConfigProblems({ nodeEnv: 'production' });
    expect(report.problems.length).toBeGreaterThanOrEqual(6);
  });

  describe('the shared rate limit store', () => {
    it('refuses to start without one, because N instances would allow N times the limit', () => {
      const report = productionConfigProblems({ ...GOOD, redisUrl: undefined });
      expect(report.problems.join(' ')).toContain('REDIS_URL is not set');
      expect(report.problems.join(' ')).toContain('RATE_LIMIT_ALLOW_PER_PROCESS');
      expect(productionConfigProblems({ ...GOOD, redisUrl: '' }).problems.join(' ')).toContain(
        'REDIS_URL is not set',
      );
    });

    it('starts without one, with a warning, when the operator says exactly one instance runs', () => {
      const report = productionConfigProblems({
        ...GOOD,
        redisUrl: undefined,
        perProcessRateLimitsAllowed: true,
      });
      expect(report.problems).toEqual([]);
      expect(report.warnings.join(' ')).toContain('RATE_LIMIT_ALLOW_PER_PROCESS');
    });

    it('refuses a Redis with no password, on this machine, or that is not Redis', () => {
      expect(problemsOf({ redisUrl: 'rediss://cache.internal.acme:6380' })).toContain(
        'REDIS_URL has no password',
      );
      expect(problemsOf({ redisUrl: 'rediss://:Qm7vLk2Xt9WdRb4N@localhost:6379' })).toContain(
        'REDIS_URL points at this machine',
      );
      expect(problemsOf({ redisUrl: 'rediss://:Qm7vLk2Xt9WdRb4N@127.0.0.1:6379' })).toContain(
        'REDIS_URL points at this machine',
      );
      expect(problemsOf({ redisUrl: 'http://:Qm7vLk2Xt9WdRb4N@cache.internal.acme' })).toContain(
        'not a redis:// or rediss:// URL',
      );
      expect(problemsOf({ redisUrl: 'not a url' })).toContain('not a redis:// or rediss:// URL');
    });

    it('warns, and does not refuse, when the connection is not encrypted', () => {
      const report = productionConfigProblems({
        ...GOOD,
        redisUrl: 'redis://:Qm7vLk2Xt9WdRb4N@cache.internal.acme:6379',
      });
      expect(report.problems).toEqual([]);
      expect(report.warnings.join(' ')).toContain('not encrypted');
    });

    it('does not ask the worker for one: it counts no requests', () => {
      const report = productionConfigProblems({ ...GOOD, scope: 'worker', redisUrl: undefined });
      expect(report.problems.join(' ')).not.toContain('REDIS_URL');
    });
  });

  it('throws one error for a bad configuration and returns the warnings for a good one', () => {
    expect(() => assertProductionConfig({ ...GOOD, authSecret: 'short' })).toThrow(
      /Refusing to start/,
    );
    expect(
      assertProductionConfig({ ...GOOD, redisUrl: undefined, perProcessRateLimitsAllowed: true }),
    ).toHaveLength(1);
    expect(assertProductionConfig(GOOD)).toEqual([]);
    expect(() => assertProductionConfig({ nodeEnv: 'development' })).not.toThrow();
  });
});
