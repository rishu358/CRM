import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './load.js';

/**
 * The branding and new-workspace-default variables (ADR-0045). They are public and chosen by
 * whoever deploys, so the point of these tests is what they refuse: a name that could break out of
 * an email, an image address that could become a script or an unexpected host, a time zone that
 * would throw the first time a due date is computed.
 */
const API = {
  DATABASE_URL: 'postgres://crm_app:pw@localhost:15432/crm',
  AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-pass-validation',
};

const problems = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvError) return error.problems.join(' | ');
    throw error;
  }
  return '';
};

describe('APP_NAME', () => {
  it('is CRM unless set, and an empty value is unset', () => {
    expect(loadEnv('web', {}).APP_NAME).toBe('CRM');
    expect(loadEnv('web', { APP_NAME: '' }).APP_NAME).toBe('CRM');
    expect(loadEnv('api', API).APP_NAME).toBe('CRM');
    expect(
      loadEnv('worker', { DATABASE_URL: API.DATABASE_URL, APP_NAME: 'Acme CRM' }).APP_NAME,
    ).toBe('Acme CRM');
  });

  it.each([
    ['too long', 'x'.repeat(61)],
    ['an angle bracket', 'Acme <b>CRM'],
    ['a control character', 'Acme\nCRM'],
  ])('refuses %s', (_why, value) => {
    expect(problems(() => loadEnv('web', { APP_NAME: value }))).toContain('APP_NAME');
  });

  it('accepts a name with punctuation and non-Latin letters', () => {
    expect(loadEnv('web', { APP_NAME: 'Sharma & Sons · ग्राहक' }).APP_NAME).toBe(
      'Sharma & Sons · ग्राहक',
    );
  });
});

describe('image and link addresses', () => {
  const ok = [
    'https://cdn.example.com/logo.svg',
    'http://localhost:9000/logo.png',
    '/brand/logo.svg',
  ];
  const refused = [
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    '//evil.example.com/logo.png',
    '/\\evil.example.com/logo.png',
    'ftp://example.com/logo.png',
    'logo.png',
    'not a url',
  ];

  for (const name of ['BRAND_LOGO_URL', 'BRAND_FAVICON_URL', 'TERMS_URL', 'PRIVACY_URL']) {
    it.each(ok)(`${name} accepts %s`, (value) => {
      expect(() => loadEnv('web', { [name]: value })).not.toThrow();
    });
    it.each(refused)(`${name} refuses %s`, (value) => {
      expect(problems(() => loadEnv('web', { [name]: value }))).toContain(name);
    });
  }
});

describe('SUPPORT_EMAIL and colours', () => {
  it('accepts an address and refuses what is not one', () => {
    expect(loadEnv('web', { SUPPORT_EMAIL: 'help@example.com' }).SUPPORT_EMAIL).toBe(
      'help@example.com',
    );
    expect(problems(() => loadEnv('web', { SUPPORT_EMAIL: 'help at example dot com' }))).toContain(
      'SUPPORT_EMAIL',
    );
  });

  it.each(['#0b6b73', '#FFFFFF', '#000000'])('accepts the colour %s', (value) => {
    expect(loadEnv('web', { BRAND_COLOR: value, BRAND_COLOR_DARK: value }).BRAND_COLOR).toBe(value);
  });

  it.each(['red', '#fff', '0b6b73', '#0b6b7', '#0b6b73ff', 'rgb(1,2,3)', 'hsl(180 80% 30%)'])(
    'refuses the colour %s',
    (value) => {
      expect(problems(() => loadEnv('web', { BRAND_COLOR: value }))).toContain('BRAND_COLOR');
      expect(problems(() => loadEnv('web', { BRAND_COLOR_DARK: value }))).toContain(
        'BRAND_COLOR_DARK',
      );
    },
  );

  it('is unset by default, so the built-in theme applies', () => {
    const env = loadEnv('web', {});
    expect(env.BRAND_COLOR).toBeUndefined();
    expect(env.BRAND_COLOR_DARK).toBeUndefined();
    expect(env.BRAND_LOGO_URL).toBeUndefined();
  });
});

describe('defaults for new workspaces', () => {
  it('keep the values the system has always used', () => {
    const env = loadEnv('api', API);
    expect(env).toMatchObject({
      DEFAULT_CURRENCY: 'INR',
      DEFAULT_TIMEZONE: 'Asia/Kolkata',
      DEFAULT_LOCALE: 'en-IN',
      DEFAULT_FISCAL_YEAR_START_MONTH: '4',
      DEFAULT_REGION: 'ap-south-1',
    });
  });

  it('can be changed to another market', () => {
    const env = loadEnv('api', {
      ...API,
      DEFAULT_CURRENCY: 'USD',
      DEFAULT_TIMEZONE: 'America/New_York',
      DEFAULT_LOCALE: 'en-US',
      DEFAULT_FISCAL_YEAR_START_MONTH: '1',
      DEFAULT_REGION: 'us-east-1',
    });
    expect(env.DEFAULT_CURRENCY).toBe('USD');
    expect(env.DEFAULT_TIMEZONE).toBe('America/New_York');
    expect(env.DEFAULT_LOCALE).toBe('en-US');
    expect(env.DEFAULT_FISCAL_YEAR_START_MONTH).toBe('1');
  });

  it.each([
    ['DEFAULT_CURRENCY', 'inr'],
    ['DEFAULT_CURRENCY', 'RUPEE'],
    ['DEFAULT_TIMEZONE', 'Mars/Olympus_Mons'],
    ['DEFAULT_TIMEZONE', 'IST'],
    ['DEFAULT_LOCALE', 'en_US'],
    ['DEFAULT_LOCALE', 'not a locale'],
    ['DEFAULT_FISCAL_YEAR_START_MONTH', '13'],
    ['DEFAULT_FISCAL_YEAR_START_MONTH', '0'],
  ])('refuse %s=%s, which would fail on first use', (name, value) => {
    expect(problems(() => loadEnv('api', { ...API, [name]: value }))).toContain(name);
  });

  it('are not part of the web or worker environment', () => {
    expect(loadEnv('web', {})).not.toHaveProperty('DEFAULT_CURRENCY');
    expect(loadEnv('worker', { DATABASE_URL: API.DATABASE_URL })).not.toHaveProperty(
      'DEFAULT_TIMEZONE',
    );
  });
});

describe('WHATSAPP_LINK_BASE', () => {
  it('is the standard chat address unless set, and an empty value is unset', () => {
    expect(loadEnv('web', {}).WHATSAPP_LINK_BASE).toBe('https://wa.me');
    expect(loadEnv('web', { WHATSAPP_LINK_BASE: '' }).WHATSAPP_LINK_BASE).toBe('https://wa.me');
  });

  it.each(['https://wa.me', 'https://wa.me/', 'https://chat.example:8443'])(
    'accepts %s',
    (value) => {
      expect(loadEnv('web', { WHATSAPP_LINK_BASE: value }).WHATSAPP_LINK_BASE).toBe(value);
    },
  );

  // The person's phone number is part of the address, so whatever this names is sent numbers.
  it.each([
    'http://wa.me',
    'javascript:alert(1)',
    'data:text/html,x',
    '//wa.me',
    'wa.me',
    'https://user@wa.me',
    'https://user:pw@wa.me',
    'https://wa.me/send',
    'https://wa.me?x=1',
    'https://wa.me/?x=1',
    'https://wa.me#x',
    'not a url',
  ])('refuses %s', (value) => {
    expect(problems(() => loadEnv('web', { WHATSAPP_LINK_BASE: value }))).toContain(
      'WHATSAPP_LINK_BASE',
    );
  });

  it('is a web setting only, so the API and the worker do not carry it', () => {
    expect('WHATSAPP_LINK_BASE' in loadEnv('api', API)).toBe(false);
  });
});
