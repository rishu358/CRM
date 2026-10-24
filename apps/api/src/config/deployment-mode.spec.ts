import { DEPLOYMENT_MODES } from '@crm/core';
import { REGISTRY } from '@crm/env';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';

/**
 * The deployment modes are declared twice: as the registry's allowed values (so the environment can be
 * validated and documented without depending on the domain package) and in `@crm/core` (the rules).
 * This is the one place that proves they are the same list.
 */
describe('DEPLOYMENT_MODE', () => {
  it('allows exactly the modes the domain rules know', () => {
    expect([...(REGISTRY.DEPLOYMENT_MODE.values ?? [])].sort()).toEqual(
      [...DEPLOYMENT_MODES].sort(),
    );
  });

  it('is multi-tenant unless set, so an existing installation is unchanged', () => {
    const base = {
      DATABASE_URL: 'postgres://crm_app:pw@localhost:15432/crm',
      AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-pass-validation',
    };
    expect(loadApiEnv(base).DEPLOYMENT_MODE).toBe('multi_tenant');
    expect(loadApiEnv({ ...base, DEPLOYMENT_MODE: 'single_tenant' }).DEPLOYMENT_MODE).toBe(
      'single_tenant',
    );
  });
});
