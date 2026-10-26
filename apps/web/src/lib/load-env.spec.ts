import { describe, expect, it } from 'vitest';
import { EnvError } from '@crm/env';
import { loadWebEnv } from './load-env';

/**
 * The web app's environment as it is loaded at start-up: the registry's rules plus the one only
 * this app applies (a configured colour must be readable). A bad value stops the app starting.
 */
const GOOD = { API_URL: 'https://api.example.com' };

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvError) return error.message;
    throw error;
  }
  return '';
};

describe('loadWebEnv', () => {
  it('loads with the defaults, and the name is CRM until configured', () => {
    const env = loadWebEnv(GOOD);
    expect(env.APP_NAME).toBe('CRM');
    expect(env.BRAND_COLOR).toBeUndefined();
  });

  it('is multi-tenant until the installation says otherwise, and carries the mode it is given', () => {
    expect(loadWebEnv(GOOD).DEPLOYMENT_MODE).toBe('multi_tenant');
    expect(loadWebEnv({ ...GOOD, DEPLOYMENT_MODE: 'single_tenant' }).DEPLOYMENT_MODE).toBe(
      'single_tenant',
    );
    expect(messageOf(() => loadWebEnv({ ...GOOD, DEPLOYMENT_MODE: 'one_tenant' }))).toContain(
      'DEPLOYMENT_MODE',
    );
  });

  it('carries the branding it is given', () => {
    const env = loadWebEnv({
      ...GOOD,
      APP_NAME: 'Orchid Desk',
      BRAND_COLOR: '#0b6b73',
      BRAND_LOGO_URL: 'https://cdn.example.com/logo.svg',
    });
    expect(env.APP_NAME).toBe('Orchid Desk');
    expect(env.BRAND_LOGO_URL).toBe('https://cdn.example.com/logo.svg');
  });

  it('refuses to start with a colour that is unreadable, and says what is wrong with it', () => {
    const message = messageOf(() => loadWebEnv({ ...GOOD, BRAND_COLOR: '#7fd6dc' }));
    expect(message).toMatch(/^Invalid web environment: BRAND_COLOR #7fd6dc is too light/);
  });

  it('refuses a malformed colour at the registry, before the readability rule', () => {
    expect(messageOf(() => loadWebEnv({ ...GOOD, BRAND_COLOR: 'teal' }))).toContain('BRAND_COLOR');
  });

  it('still refuses a pasted database URL outside local development, without repeating it', () => {
    const message = messageOf(() =>
      loadWebEnv({
        ...GOOD,
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://crm_app:s3cr3t-pw@db.example.com/crm',
      }),
    );
    expect(message).toContain('DATABASE_URL must not be set on the web app');
    expect(message).not.toContain('s3cr3t-pw');
  });
});
