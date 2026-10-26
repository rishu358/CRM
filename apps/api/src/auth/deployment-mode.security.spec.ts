import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SignUpDisabledError } from '@crm/core';
import { request, startApiHarness, tokenFromEmail, type ApiHarness } from '../testing/harness.js';
import { GoogleAuthService } from './google.service.js';

/**
 * A single-tenant installation does not let strangers create workspaces (ADR-0046), and being
 * closed must cost nothing: no account, no workspace, no email, and no way to learn who has an
 * account here. Everyone who already belongs still signs in the same way. A multi-tenant
 * installation is untouched.
 */
let multi: ApiHarness;
let single: ApiHarness;

const PASSWORD = 'correct-horse-battery-staple';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Create an account the ordinary way, on a harness that allows it, and confirm it. */
async function existingAccount(harness: ApiHarness, prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const signUp = await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Test Person' },
  });
  expect(signUp.status).toBe(202);
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
  });
  return email;
}

beforeAll(async () => {
  multi = await startApiHarness(inject('dbUrls'));
  single = await startApiHarness(inject('dbUrls'), { DEPLOYMENT_MODE: 'single_tenant' });
}, 240_000);

afterAll(async () => {
  await multi.close();
  await single.close();
});

describe('public sign-up on a single-tenant installation', () => {
  it('is refused with a stable code, and creates nothing', async () => {
    const email = uniqueEmail('stranger');
    const workspace = `Their Company ${Date.now().toString(36)}`;

    const response = await request(single, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'A Stranger', companyName: workspace },
    });

    expect(response.status).toBe(403);
    expect((response.body['error'] as { code: string }).code).toBe('SIGN_UP_DISABLED');
    expect(await single.fixtures.userExists(email)).toBe(false);
    expect(await single.fixtures.tenantNamed(workspace)).toBe(false);
    expect(single.emails.lastTo(email)).toBeUndefined();
  });

  it('answers the same whether or not the address already has an account', async () => {
    // Otherwise the closed door would double as an oracle for who has an account here.
    const existing = await existingAccount(multi, 'member');
    const asked = async (email: string) =>
      request(single, {
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        body: { email, password: PASSWORD, name: 'Anyone' },
      });

    const known = await asked(existing);
    const unknown = await asked(uniqueEmail('nobody'));
    expect(known.status).toBe(403);
    expect(unknown.status).toBe(403);
    const code = (r: typeof known) => (r.body['error'] as { code: string; message: string }).code;
    expect(code(known)).toBe(code(unknown));
    // No "you already have an account" email either: that would answer the question.
    expect(single.emails.lastTo(existing)).toBeUndefined();
  });

  it('still lets an existing account sign in', async () => {
    // The shared test database is one database: an account made on the open harness exists for
    // the closed one too, as it would for the installation's own people.
    const email = await existingAccount(multi, 'resident');
    const signedIn = await request(single, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email, password: PASSWORD },
    });
    expect(signedIn.status).toBe(200);
    expect((signedIn.body['data'] as { status: string }).status).toBe('signed_in');
  });

  it('still lets an existing account reset its password', async () => {
    const email = await existingAccount(multi, 'forgot');
    const response = await request(single, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    expect(response.status).toBeLessThan(300);
    expect(single.emails.lastTo(email)?.subject).toContain('Reset your');
  });
});

describe('Google sign-in on a single-tenant installation', () => {
  const identity = (email: string, verified = true) => ({
    accountId: `google-${Math.random().toString(36).slice(2)}`,
    email,
    emailVerified: verified,
    name: 'Someone',
    image: null,
  });

  it('does not create an account for a stranger', async () => {
    const email = uniqueEmail('google-new');
    const google = single.app.get(GoogleAuthService);

    await expect(google.resolveUser(identity(email))).rejects.toBeInstanceOf(SignUpDisabledError);
    expect(await single.fixtures.userExists(email)).toBe(false);
  });

  it('still signs in an account that already exists, by its verified address', async () => {
    const email = await existingAccount(multi, 'google-existing');
    const google = single.app.get(GoogleAuthService);

    const resolved = await google.resolveUser(identity(email));
    expect(resolved.created).toBe(false);
  });

  it('creates accounts as before on a multi-tenant installation', async () => {
    const email = uniqueEmail('google-open');
    const google = multi.app.get(GoogleAuthService);

    const resolved = await google.resolveUser(identity(email));
    expect(resolved.created).toBe(true);
    expect(await multi.fixtures.userExists(email)).toBe(true);
  });
});

describe('a multi-tenant installation', () => {
  it('still lets anyone sign up', async () => {
    const email = await existingAccount(multi, 'open');
    expect(await multi.fixtures.userExists(email)).toBe(true);
  });
});
