import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';

/**
 * The unsubscribe link's own secret (ADR-0076) as the API loads it: optional outside production, and a malformed
 * list of earlier keys refuses to start, naming the variable and never a key. Production's own requirement for
 * it is tested with the rest of the production guard, in `packages/core`.
 */
const base = {
  DATABASE_URL: 'postgres://crm_app:pw@localhost:15432/crm',
  AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-pass-validation',
};
const KEY = 'k'.repeat(40);
const OLD_1 = 'p'.repeat(40);
const OLD_2 = 'q'.repeat(40);
const OLD_3 = 'r'.repeat(40);
const OLD_4 = 's'.repeat(40);

describe('EMAIL_UNSUBSCRIBE_SECRET', () => {
  it('is not needed to start outside production', () => {
    const env = loadApiEnv(base);
    expect(env.EMAIL_UNSUBSCRIBE_SECRET).toBeUndefined();
    expect(env.EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS).toBeUndefined();
  });

  it('is read when it is given, with its earlier keys', () => {
    const env = loadApiEnv({
      ...base,
      EMAIL_UNSUBSCRIBE_SECRET: KEY,
      EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: `${OLD_1},${OLD_2}`,
    });
    expect(env.EMAIL_UNSUBSCRIBE_SECRET).toBe(KEY);
  });

  it('refuses a key that is too short, without printing it', () => {
    expect(() => loadApiEnv({ ...base, EMAIL_UNSUBSCRIBE_SECRET: 'short' })).toThrow(
      /EMAIL_UNSUBSCRIBE_SECRET/,
    );
    try {
      loadApiEnv({ ...base, EMAIL_UNSUBSCRIBE_SECRET: 'short-secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('short-secret-value');
    }
  });

  it('refuses earlier keys with no current one, too many, too short, or the current one among them', () => {
    expect(() => loadApiEnv({ ...base, EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: OLD_1 })).toThrow(
      'needs EMAIL_UNSUBSCRIBE_SECRET to be set',
    );
    expect(() =>
      loadApiEnv({
        ...base,
        EMAIL_UNSUBSCRIBE_SECRET: KEY,
        EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: [OLD_1, OLD_2, OLD_3, OLD_4].join(','),
      }),
    ).toThrow('at most 3 are accepted');
    expect(() =>
      loadApiEnv({
        ...base,
        EMAIL_UNSUBSCRIBE_SECRET: KEY,
        EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: `${OLD_1},short`,
      }),
    ).toThrow('at least 32 characters');
    expect(() =>
      loadApiEnv({
        ...base,
        EMAIL_UNSUBSCRIBE_SECRET: KEY,
        EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: `${OLD_1},${KEY}`,
      }),
    ).toThrow('must not also be listed');
  });
});
