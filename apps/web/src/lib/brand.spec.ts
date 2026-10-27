import { describe, expect, it } from 'vitest';
import { brandProblems, brandStyle, imageOrigins, publicBrand, type BrandEnv } from './brand';
import { buildCsp } from './csp';

/**
 * The web app's branding (ADR-0045): what is handed to components, what goes on the root element,
 * what the content security policy lets through for images.
 */
const bare: BrandEnv = { APP_NAME: 'CRM', WHATSAPP_LINK_BASE: 'https://chat.example' };

describe('publicBrand', () => {
  it('hands components the name and whatever else is configured, and null for the rest', () => {
    expect(publicBrand(bare)).toEqual({
      signUpOpen: true,
      name: 'CRM',
      logoUrl: null,
      faviconUrl: null,
      supportEmail: null,
      termsUrl: null,
      privacyUrl: null,
      whatsappLinkBase: 'https://chat.example',
    });
    expect(
      publicBrand({
        APP_NAME: 'Orchid Desk',
        BRAND_LOGO_URL: 'https://cdn.example.com/logo.svg',
        BRAND_FAVICON_URL: '/brand/favicon.png',
        SUPPORT_EMAIL: 'help@example.com',
        TERMS_URL: 'https://example.com/terms',
        PRIVACY_URL: '/privacy',
        WHATSAPP_LINK_BASE: 'https://chat.example',
      }),
    ).toEqual({
      signUpOpen: true,
      name: 'Orchid Desk',
      logoUrl: 'https://cdn.example.com/logo.svg',
      faviconUrl: '/brand/favicon.png',
      supportEmail: 'help@example.com',
      termsUrl: 'https://example.com/terms',
      privacyUrl: '/privacy',
      whatsappLinkBase: 'https://chat.example',
    });
  });
});

describe('whether the installation takes sign-ups (ADR-0046)', () => {
  it('is open by default and on a multi-tenant installation', () => {
    expect(publicBrand(bare).signUpOpen).toBe(true);
    expect(publicBrand({ ...bare, DEPLOYMENT_MODE: 'multi_tenant' }).signUpOpen).toBe(true);
  });

  it('is closed on a single-tenant installation', () => {
    expect(publicBrand({ ...bare, DEPLOYMENT_MODE: 'single_tenant' }).signUpOpen).toBe(false);
  });
});

describe('brandStyle and brandProblems', () => {
  it('are empty with no colour set, so the stock theme applies', () => {
    expect(brandStyle(bare)).toEqual({});
    expect(brandProblems(bare)).toEqual([]);
  });

  it('turn an accepted colour into custom properties on the root element', () => {
    const env = { ...bare, BRAND_COLOR: '#0b6b73', BRAND_COLOR_DARK: '#3ad0d8' };
    const style = brandStyle(env);
    expect(style).toHaveProperty('--brand-primary');
    expect(style).toHaveProperty('--brand-primary-dark');
    expect(style['--brand-primary']).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
    expect(brandProblems(env)).toEqual([]);
  });

  it('refuse a colour that would be unreadable, naming the setting, and emit nothing for it', () => {
    const env = { ...bare, BRAND_COLOR: '#7fd6dc', BRAND_COLOR_DARK: '#0b6b73' };
    const problems = brandProblems(env);
    expect(problems.some((p) => p.startsWith('BRAND_COLOR #7fd6dc is too light'))).toBe(true);
    expect(problems.some((p) => p.startsWith('BRAND_COLOR_DARK #0b6b73 is too dark'))).toBe(true);
    expect(brandStyle(env)).toEqual({});
  });
});

describe('imageOrigins', () => {
  it('is the host of an absolute logo or favicon and nothing for a local path', () => {
    expect(imageOrigins(bare)).toEqual([]);
    expect(imageOrigins({ ...bare, BRAND_LOGO_URL: '/brand/logo.svg' })).toEqual([]);
    expect(
      imageOrigins({
        ...bare,
        BRAND_LOGO_URL: 'https://cdn.example.com/a/logo.svg',
        BRAND_FAVICON_URL: 'https://cdn.example.com/favicon.png',
      }),
    ).toEqual(['https://cdn.example.com']);
    expect(
      imageOrigins({
        ...bare,
        BRAND_LOGO_URL: 'https://cdn.example.com/logo.svg',
        BRAND_FAVICON_URL: 'https://icons.example.org/f.ico',
      }),
    ).toEqual(['https://cdn.example.com', 'https://icons.example.org']);
  });

  it('reaches the policy as the only change to it', () => {
    const base = {
      nonce: 'dGhpcyBpcyBhIG5vbmNlIQ==',
      development: false,
      https: true,
      connectOrigins: [],
    };
    const plain = buildCsp({ ...base, imgOrigins: imageOrigins(bare) });
    const branded = buildCsp({
      ...base,
      imgOrigins: imageOrigins({ ...bare, BRAND_LOGO_URL: 'https://cdn.example.com/logo.svg' }),
    });
    expect(branded.replace(' https://cdn.example.com', '')).toBe(plain);
  });
});
