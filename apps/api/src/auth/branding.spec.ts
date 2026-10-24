import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, tokenFromEmail, type ApiHarness } from '../testing/harness.js';

/**
 * What an installation calls itself, and what a new workspace starts with, come from configuration
 * and not from the code (ADR-0045). This signs up, resets a password and enrols an authenticator on
 * an installation that is not called "CRM" and is not in India, and checks that nothing says
 * otherwise: not an email, not the authenticator's issuer, not the new workspace.
 */
let harness: ApiHarness;

const PASSWORD = 'correct-horse-battery-staple';
const NAME = 'Orchid Desk';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'), {
    APP_NAME: NAME,
    DEFAULT_CURRENCY: 'USD',
    DEFAULT_TIMEZONE: 'America/New_York',
    DEFAULT_LOCALE: 'en-US',
    DEFAULT_FISCAL_YEAR_START_MONTH: '1',
    DEFAULT_REGION: 'us-east-1',
  });
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('an installation with its own name and market', () => {
  it('names itself in the sign-up and duplicate-sign-up emails, and nowhere says CRM', async () => {
    const email = uniqueEmail('brand');
    const signUp = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    expect(signUp.status).toBe(202);

    const confirm = harness.emails.lastTo(email);
    expect(confirm?.text).toContain(`finish setting up your ${NAME} account`);
    expect(`${confirm?.subject}${confirm?.text}`).not.toContain('CRM');

    // Sign up again with the same address: the "you already have an account" email.
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    const exists = harness.emails.lastTo(email);
    expect(exists?.subject).toBe(`You already have an account on ${NAME}`);
    expect(exists?.text).toContain(`create an account on ${NAME}`);
    expect(`${exists?.subject}${exists?.text}`).not.toContain('CRM');
  });

  it('starts a new workspace and its first user with the configured defaults', async () => {
    const email = uniqueEmail('defaults');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
    });
    const signedIn = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email, password: PASSWORD },
    });
    const { tenantId } = signedIn.body['data'] as { tenantId: string };

    expect(await harness.fixtures.workspaceDefaults(tenantId, email)).toEqual({
      region: 'us-east-1',
      currency: 'USD',
      timezone: 'America/New_York',
      locale: 'en-US',
      fiscalYearStartMonth: '1',
      userLocale: 'en-US',
      userTimezone: 'America/New_York',
    });
  });

  it('names itself in the password-reset email', async () => {
    const email = uniqueEmail('reset');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
    });

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    const reset = harness.emails.lastTo(email);
    expect(reset?.subject).toBe(`Reset your ${NAME} password`);
    expect(`${reset?.subject}${reset?.text}`).not.toContain('CRM');
  });

  it('enrols an authenticator under its own name', async () => {
    const email = uniqueEmail('totp');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
    });
    const signedIn = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email, password: PASSWORD },
    });
    const { token } = signedIn.body['data'] as { token: string };

    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token,
    });
    expect(enrolment.status).toBe(201);
    const { otpauthUrl } = enrolment.body['data'] as { otpauthUrl: string };
    expect(decodeURIComponent(otpauthUrl)).toContain(NAME);
    expect(otpauthUrl).not.toContain('CRM');
  });
});
