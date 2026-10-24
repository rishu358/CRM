import { describe, expect, it } from 'vitest';
import {
  assertConnectedRoles,
  assertProductionConfig,
  connectedRoleProblems,
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
  redisUrl: 'rediss://cache.internal.acme:6380',
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
    expect(problemsOf({ emailProvider: 'sendgrid' })).toContain(
      'not a provider this build can send with',
    );
    expect(problemsOf({ resendApiKey: undefined })).toContain('requires RESEND_API_KEY');
    expect(problemsOf({ resendApiKey: '' })).toContain('requires RESEND_API_KEY');
  });

  it('accepts Amazon SES with a region and both keys, and names each one that is missing', () => {
    const ses = {
      emailProvider: 'ses',
      resendApiKey: undefined,
      sesRegion: 'ap-south-1',
      sesAccessKeyId: 'AKIAEXAMPLE',
      sesSecretAccessKey: 'wJalrXUtnFEMI',
    };
    expect(problemsOf(ses)).toBe('');
    expect(problemsOf({ ...ses, sesRegion: undefined })).toBe(
      'EMAIL_PROVIDER=ses requires SES_REGION',
    );
    expect(problemsOf({ ...ses, sesAccessKeyId: '' })).toBe(
      'EMAIL_PROVIDER=ses requires SES_ACCESS_KEY_ID',
    );
    expect(problemsOf({ ...ses, sesSecretAccessKey: undefined })).toBe(
      'EMAIL_PROVIDER=ses requires SES_SECRET_ACCESS_KEY',
    );
    // Never a value: not even in the problem about the key next to it.
    expect(problemsOf({ ...ses, sesRegion: undefined })).not.toContain('wJalrXUtnFEMI');
  });

  it('accepts SMTP over TLS, and refuses it without a host, in clear, or with half a login', () => {
    const smtp = {
      emailProvider: 'smtp',
      resendApiKey: undefined,
      smtpHost: 'smtp.mail.example.com',
      smtpSecurity: 'starttls',
      smtpUser: 'no-reply@mail.example.com',
      smtpPassword: 'a-real-password',
    };
    expect(problemsOf(smtp)).toBe('');
    expect(problemsOf({ ...smtp, smtpSecurity: 'tls' })).toBe('');
    // A relay that trusts the sender by address needs no login at all.
    expect(problemsOf({ ...smtp, smtpUser: undefined, smtpPassword: undefined })).toBe('');
    expect(problemsOf({ ...smtp, smtpHost: undefined })).toBe(
      'EMAIL_PROVIDER=smtp requires SMTP_HOST',
    );
    expect(problemsOf({ ...smtp, smtpSecurity: 'none' })).toContain('SMTP_SECURITY=none');
    expect(problemsOf({ ...smtp, smtpPassword: undefined })).toContain(
      'SMTP_USER and SMTP_PASSWORD must be set together',
    );
    expect(problemsOf({ ...smtp, smtpSecurity: 'none' })).not.toContain('a-real-password');
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

  it('warns, and does not refuse, when rate limits cannot be shared', () => {
    const report = productionConfigProblems({ ...GOOD, redisUrl: undefined });
    expect(report.problems).toEqual([]);
    expect(report.warnings.join(' ')).toContain('REDIS_URL');
  });

  it('throws one error for a bad configuration and returns the warnings for a good one', () => {
    expect(() => assertProductionConfig({ ...GOOD, authSecret: 'short' })).toThrow(
      /Refusing to start/,
    );
    expect(assertProductionConfig({ ...GOOD, redisUrl: undefined })).toHaveLength(1);
    expect(assertProductionConfig(GOOD)).toEqual([]);
    expect(() => assertProductionConfig({ nodeEnv: 'development' })).not.toThrow();
  });
});

describe('the managed-database admin role', () => {
  it('is refused by name, whatever its password', () => {
    const report = productionConfigProblems({
      ...GOOD,
      databaseUrls: { DATABASE_URL: 'postgres://doadmin:Zk3pQ8vLm2Xr@db.example.io:25060/crm' },
    });
    expect(report.problems.join(' | ')).toContain(
      'DATABASE_URL connects as the managed-database admin role',
    );
  });
});

describe('what the database says the connected role is', () => {
  const app = { name: 'crm_app', superuser: false, bypassRls: false };

  it('accepts a role that cannot bypass row-level security', () => {
    expect(connectedRoleProblems('DATABASE_URL', app)).toEqual([]);
    expect(() => assertConnectedRoles({ DATABASE_URL: app })).not.toThrow();
  });

  it('refuses BYPASSRLS, a superuser, and both, naming the variable and the role', () => {
    expect(
      connectedRoleProblems('DATABASE_URL', { ...app, name: 'doadmin', bypassRls: true }),
    ).toEqual(['DATABASE_URL connects as role "doadmin", which has BYPASSRLS']);
    expect(connectedRoleProblems('DATABASE_AUTH_URL', { ...app, superuser: true })).toEqual([
      'DATABASE_AUTH_URL connects as role "crm_app", which is a superuser',
    ]);
    expect(
      connectedRoleProblems('X', { name: 'postgres', superuser: true, bypassRls: true }),
    ).toHaveLength(2);
  });

  it('reports every offending connection at once and nothing else', () => {
    const attempt = () =>
      assertConnectedRoles({
        DATABASE_URL: app,
        DATABASE_AUTH_URL: { name: 'doadmin', superuser: false, bypassRls: true },
        DATABASE_WORKER_URL: { name: 'postgres', superuser: true, bypassRls: true },
      });
    expect(attempt).toThrow(/Refusing to start: a database connection can bypass/);
    expect(attempt).toThrow(/DATABASE_AUTH_URL.*doadmin/);
    expect(attempt).toThrow(/DATABASE_WORKER_URL.*postgres/);
    expect(attempt).not.toThrow(/DATABASE_URL connects/);
  });
});
