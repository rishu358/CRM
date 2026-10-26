import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, redactedEnv, variablesFor } from './load.js';

const API_MIN = {
  DATABASE_URL: 'postgres://crm_app:pw@localhost:15432/crm',
  AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-pass-validation',
};

/** The error a load throws, so a test can read its problems. */
function failure(run: () => unknown): EnvError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('expected the load to throw');
}

describe('loadEnv', () => {
  it('returns typed values with the registry defaults applied', () => {
    const env = loadEnv('api', API_MIN);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.EMAIL_PROVIDER).toBe('console');
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('applies a default that differs by scope', () => {
    expect(loadEnv('worker', { DATABASE_URL: API_MIN.DATABASE_URL }).DATABASE_POOL_MAX).toBe(5);
    expect(loadEnv('db', { DATABASE_URL: API_MIN.DATABASE_URL }).DATABASE_POOL_MAX).toBe(10);
  });

  it('reads numbers and flags from text', () => {
    const env = loadEnv('api', {
      ...API_MIN,
      API_PORT: '8080',
      S3_FORCE_PATH_STYLE: 'true',
      RATE_LIMIT_MAX_PER_USER: '42',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.RATE_LIMIT_MAX_PER_USER).toBe(42);
  });

  it('treats an empty string as not set, so "FOO=" really leaves it blank', () => {
    const env = loadEnv('api', {
      ...API_MIN,
      REDIS_URL: '',
      S3_ENDPOINT: '',
      API_PORT: '',
      EMAIL_FROM: '',
    });
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.API_PORT).toBe(3001);
    expect(env.EMAIL_FROM).toBe('no-reply@localhost');
  });

  it('returns only the variables registered for the scope', () => {
    const env = loadEnv('web', { API_URL: 'https://api.example.com', SOME_OTHER_THING: 'x' });
    const registered = variablesFor('web').map(([name]) => name);
    expect(Object.keys(env).every((name) => registered.includes(name))).toBe(true);
    expect(env).not.toHaveProperty('SOME_OTHER_THING');
    // Registered for the API only, so absent here even though the source could have supplied it.
    expect(env).not.toHaveProperty('DATABASE_POOL_MAX');
  });

  it('does not put variables of other scopes on the type', () => {
    const env = loadEnv('web', {});
    // @ts-expect-error DATABASE_URL is not registered for the web scope, so it is not on its type.
    expect(env.DATABASE_URL).toBeUndefined();
    // @ts-expect-error AUTH_SECRET is not registered for the web scope either.
    expect(env.AUTH_SECRET).toBeUndefined();
  });

  describe('APP_ENV', () => {
    it('is local unless production, so existing deployments need no new variable', () => {
      expect(loadEnv('api', API_MIN).APP_ENV).toBe('local');
      expect(loadEnv('api', { ...API_MIN, NODE_ENV: 'test' }).APP_ENV).toBe('local');
      expect(loadEnv('api', { ...API_MIN, NODE_ENV: 'production' }).APP_ENV).toBe('production');
    });

    it('is whatever is set, so staging can be said', () => {
      const env = loadEnv('api', { ...API_MIN, NODE_ENV: 'production', APP_ENV: 'staging' });
      expect(env.APP_ENV).toBe('staging');
    });

    it('refuses a value that is not an environment', () => {
      expect(
        failure(() => loadEnv('api', { ...API_MIN, APP_ENV: 'prod' })).problems.join(),
      ).toContain('APP_ENV');
    });
  });

  describe('errors', () => {
    it('lists every problem at once, so a deployment is fixed in one pass', () => {
      const error = failure(() =>
        loadEnv('api', {
          SESSION_TTL_DAYS: 'forever',
          API_PORT: '-1',
          EMAIL_PROVIDER: 'carrier-pigeon',
        }),
      );
      const text = error.problems.join(' | ');
      for (const name of [
        'DATABASE_URL',
        'AUTH_SECRET',
        'SESSION_TTL_DAYS',
        'API_PORT',
        'EMAIL_PROVIDER',
      ]) {
        expect(text, name).toContain(name);
      }
      expect(error.message).toMatch(/^Invalid API environment: /);
    });

    it('says where to get a missing required value', () => {
      const text = failure(() => loadEnv('api', {})).problems.join(' | ');
      expect(text).toContain('AUTH_SECRET is not set (get it: ');
      expect(text).toContain('openssl rand -base64 48');
    });

    it('never repeats a secret it was given', () => {
      const secret = 'hunter2-hunter2-hunter2-hunter2'.slice(0, 8);
      const error = failure(() => loadEnv('api', { ...API_MIN, AUTH_SECRET: secret }));
      expect(error.message).toContain('AUTH_SECRET must be at least 32 characters');
      expect(error.message).not.toContain(secret);
    });

    it('names the scope in the message', () => {
      expect(failure(() => loadEnv('worker', {})).message).toMatch(/^Invalid worker environment/);
      expect(failure(() => loadEnv('db', {})).message).toMatch(/^Invalid database environment/);
      expect(failure(() => loadEnv('web', { API_URL: 'not a url' })).message).toMatch(
        /^Invalid web environment/,
      );
    });
  });

  describe('the web app and credentials it must not hold', () => {
    const PASTED = {
      API_URL: 'https://api.example.com',
      DATABASE_URL: 'postgres://crm_app:s3cr3t-pw@db.example.com/crm',
      AUTH_SECRET: API_MIN.AUTH_SECRET,
    };

    it('refuses to start outside local development while holding a secret meant for another process', () => {
      const error = failure(() => loadEnv('web', { ...PASTED, APP_ENV: 'production' }));
      expect(error.message).toContain('DATABASE_URL');
      expect(error.message).toContain('AUTH_SECRET');
      expect(error.message).toContain('must not be set on the web app');
      expect(error.message).toContain('set APP_ENV=local');
      expect(error.message).not.toContain('s3cr3t-pw');
    });

    it('does so on staging too, and when production is only implied by NODE_ENV', () => {
      expect(() => loadEnv('web', { ...PASTED, APP_ENV: 'staging' })).toThrow(EnvError);
      expect(() => loadEnv('web', { ...PASTED, NODE_ENV: 'production' })).toThrow(EnvError);
    });

    it('allows it locally, where the repository `.env` is shared by every process', () => {
      expect(() => loadEnv('web', { ...PASTED, APP_ENV: 'local' })).not.toThrow();
      expect(() => loadEnv('web', PASTED)).not.toThrow();
    });

    it('accepts the variables the web app does use', () => {
      const env = loadEnv('web', {
        API_URL: 'https://api.example.com',
        S3_PUBLIC_ENDPOINT: 'https://files.example.com',
        APP_ENV: 'production',
      });
      expect(env.API_URL).toBe('https://api.example.com');
    });

    it('ignores non-secret variables that belong to others (a port, a log level)', () => {
      expect(() =>
        loadEnv('web', {
          API_URL: 'https://api.example.com',
          APP_ENV: 'production',
          API_PORT: '3001',
          LOG_LEVEL: 'info',
        }),
      ).not.toThrow();
    });

    it('does not apply to the processes that do hold those secrets', () => {
      expect(() => loadEnv('api', { ...API_MIN, APP_ENV: 'production' })).not.toThrow();
    });
  });
});

describe('redactedEnv', () => {
  it('replaces secrets, shows everything else, and marks what is unset', () => {
    const env = loadEnv('api', { ...API_MIN, REDIS_URL: 'redis://:pw@cache:6379' });
    const shown = redactedEnv('api', env);
    expect(shown['DATABASE_URL']).toBe('[redacted]');
    expect(shown['AUTH_SECRET']).toBe('[redacted]');
    expect(shown['REDIS_URL']).toBe('[redacted]');
    expect(shown['API_PORT']).toBe('3001');
    expect(shown['RESEND_API_KEY']).toBe('(unset)');
    expect(JSON.stringify(shown)).not.toContain('pw');
    expect(JSON.stringify(shown)).not.toContain(API_MIN.AUTH_SECRET);
  });
});
