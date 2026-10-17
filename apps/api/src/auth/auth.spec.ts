import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createOTP } from '@better-auth/utils/otp';
import { request, startApiHarness, tokenFromEmail, type ApiHarness } from '../testing/harness.js';

/**
 * The authentication flows end to end (MVP_SPEC M1).
 *
 * Against the real HTTP stack and a real Postgres with RLS, because what is
 * being checked — that a token is single-use, that a password change revokes
 * sessions, that a workspace can require MFA — is produced by the controller,
 * the service, the session layer and the database together. Mocking any of
 * them would prove nothing about the property.
 *
 * Tokens are read out of the captured email, the same way a user reads them
 * out of their inbox: the database only ever holds their hashes.
 */
let harness: ApiHarness;

const PASSWORD = 'correct-horse-battery-staple';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Sign up and click the verification link. Returns the address. */
async function signUpVerified(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const signUp = await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Test Person' },
  });
  expect(signUp.status).toBe(202);

  const message = harness.emails.lastTo(email);
  expect(message).toBeDefined();
  const verify = await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(message!.text) },
  });
  expect(verify.status).toBe(204);
  return email;
}

async function signIn(email: string, password = PASSWORD) {
  return request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { email, password },
  });
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('sign-up', () => {
  it('creates an account, a workspace and an owner membership', async () => {
    const email = await signUpVerified('signup');

    const signedIn = await signIn(email);
    expect(signedIn.status).toBe(200);
    const data = signedIn.body['data'] as { status: string; token: string; tenantId: string };
    expect(data.status).toBe('signed_in');
    expect(data.tenantId).toEqual(expect.any(String));

    // The workspace is usable, not just present: the founder can reach a
    // business endpoint, which only works if roles and grants were provisioned.
    const contacts = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: data.token,
    });
    expect(contacts.status).toBe(200);
  });

  it('rejects a weak password before any account is created', async () => {
    const email = uniqueEmail('weak');
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: 'short', name: 'Test Person' },
    });
    expect(response.status).toBe(422);
    expect(harness.emails.lastTo(email)).toBeUndefined();
  });

  it('refuses unknown keys in the body', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: {
        email: uniqueEmail('strict'),
        password: PASSWORD,
        name: 'Test Person',
        tenantId: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect(response.status).toBe(422);
  });
});

describe('email verification', () => {
  it('refuses sign-in until the address is confirmed', async () => {
    const email = uniqueEmail('unverified');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });

    const response = await signIn(email);
    expect(response.status).toBe(403);
    expect((response.body['error'] as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('accepts a verification token once and never again', async () => {
    const email = uniqueEmail('once');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    const token = tokenFromEmail(harness.emails.lastTo(email)!.text);

    const first = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token },
    });
    expect(first.status).toBe(204);

    const second = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token },
    });
    expect(second.status).toBe(400);
    expect((second.body['error'] as { code: string }).code).toBe('INVALID_TOKEN');
  });
});

describe('sign-in', () => {
  it('refuses the wrong password', async () => {
    const email = await signUpVerified('wrongpw');
    const response = await signIn(email, 'not-the-right-password');
    expect(response.status).toBe(401);
    expect((response.body['error'] as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });

  it('sets an httpOnly session cookie', async () => {
    const email = await signUpVerified('cookie');
    const response = await harness.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, password: PASSWORD }),
      });

    const cookie = response.headers['set-cookie'];
    const serialised = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(serialised).toContain('crm_session=');
    expect(serialised.toLowerCase()).toContain('httponly');
    expect(serialised.toLowerCase()).toContain('samesite=lax');
  });
});

describe('brute-force protection (M1 acceptance)', () => {
  it('delays further attempts after five failures and records the event', async () => {
    const email = await signUpVerified('throttle');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await signIn(email, `wrong-password-${String(attempt)}`);
      expect(response.status).toBe(401);
    }

    const started = Date.now();
    const sixth = await signIn(email, 'wrong-password-again');
    const elapsed = Date.now() - started;

    expect(sixth.status).toBe(401);
    // The harness caps the delay at 50ms so the suite stays quick; the
    // assertion is that a delay happened at all, which is what would
    // disappear if the throttle were removed.
    expect(elapsed).toBeGreaterThanOrEqual(45);

    const events = await harness.fixtures.authEvents({ email });
    expect(events.some((event) => event.type === 'login_throttled')).toBe(true);
    expect(events.filter((event) => event.type === 'login_failed')).toHaveLength(6);
  });

  it('still delays an attempt that would have succeeded', async () => {
    const email = await signUpVerified('throttle-ok');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(email, `wrong-${String(attempt)}`);
    }

    const started = Date.now();
    const response = await signIn(email);
    const elapsed = Date.now() - started;

    // A correct password answered instantly while a wrong one waits is a
    // timing oracle, so success is delayed too.
    expect(response.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

describe('password reset', () => {
  it('sets a new password and signs out every session (M1 acceptance)', async () => {
    const email = await signUpVerified('reset');
    const first = await signIn(email);
    const token = (first.body['data'] as { token: string }).token;

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    const resetToken = tokenFromEmail(harness.emails.lastTo(email)!.text);

    const newPassword = 'a-completely-different-passphrase';
    const reset = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      body: { token: resetToken, password: newPassword },
    });
    expect(reset.status).toBe(204);

    // The session that existed before the reset is dead.
    const afterReset = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token,
    });
    expect(afterReset.status).toBe(401);

    expect((await signIn(email, newPassword)).status).toBe(200);
    expect((await signIn(email)).status).toBe(401);
  });

  it('refuses a reset token a second time', async () => {
    const email = await signUpVerified('reset-once');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    const resetToken = tokenFromEmail(harness.emails.lastTo(email)!.text);

    const body = { token: resetToken, password: 'another-good-long-passphrase' };
    expect(
      (await request(harness, { method: 'POST', url: '/api/v1/auth/reset-password', body })).status,
    ).toBe(204);
    expect(
      (await request(harness, { method: 'POST', url: '/api/v1/auth/reset-password', body })).status,
    ).toBe(400);
  });

  it('issuing a new reset link retires the previous one', async () => {
    const email = await signUpVerified('reset-retire');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    const stale = tokenFromEmail(harness.emails.lastTo(email)!.text);

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email },
    });
    const fresh = tokenFromEmail(harness.emails.lastTo(email)!.text);
    expect(fresh).not.toBe(stale);

    const usingStale = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      body: { token: stale, password: 'yet-another-long-passphrase' },
    });
    expect(usingStale.status).toBe(400);
  });
});

describe('changing the password (M1 acceptance)', () => {
  it('revokes all other sessions and keeps the caller signed in', async () => {
    const email = await signUpVerified('change');
    const browser = (await signIn(email)).body['data'] as { token: string };
    const phone = (await signIn(email)).body['data'] as { token: string };

    const response = await harness.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${browser.token}`,
        },
        payload: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: 'the-new-and-longer-passphrase',
        }),
      });
    expect(response.statusCode).toBe(200);

    // The other device is signed out.
    const fromPhone = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: phone.token,
    });
    expect(fromPhone.status).toBe(401);

    // And so is the old token for this device — replaced by the cookie the
    // response just set, which is what the browser will send next.
    const withOldToken = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: browser.token,
    });
    expect(withOldToken.status).toBe(401);

    const cookie = response.headers['set-cookie'];
    expect(Array.isArray(cookie) ? cookie.join(';') : String(cookie)).toContain('crm_session=');
  });

  it('refuses the wrong current password', async () => {
    const email = await signUpVerified('change-wrong');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/change-password',
      token,
      body: { currentPassword: 'nope-not-this-one', newPassword: 'a-brand-new-passphrase' },
    });
    expect(response.status).toBe(401);
  });
});

describe('sessions', () => {
  it('lists this device and signs the others out', async () => {
    const email = await signUpVerified('sessions');
    const here = ((await signIn(email)).body['data'] as { token: string }).token;
    await signIn(email);
    await signIn(email);

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: here,
    });
    expect(list.status).toBe(200);
    const sessions = list.body['data'] as { id: string; current: boolean }[];
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);

    const revoked = await request(harness, {
      method: 'DELETE',
      url: '/api/v1/auth/sessions/others',
      token: here,
    });
    expect(revoked.status).toBe(200);
    expect((revoked.body['data'] as { revoked: number }).revoked).toBeGreaterThanOrEqual(2);

    // Still signed in here.
    const after = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: here,
    });
    expect(after.status).toBe(200);
    expect(after.body['data']).toHaveLength(1);
  });

  it('never returns a session token in the list', async () => {
    const email = await signUpVerified('no-token');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token,
    });
    expect(JSON.stringify(list.body)).not.toContain(token);
  });
});

describe('TOTP MFA', () => {
  /** Enrol, activate, and hand back the secret and backup codes. */
  async function enrol(token: string): Promise<{ secret: string; backupCodes: string[] }> {
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token,
    });
    expect(enrolment.status).toBe(201);
    const data = enrolment.body['data'] as {
      secret: string;
      otpauthUrl: string;
      backupCodes: string[];
    };
    expect(data.otpauthUrl).toContain('otpauth://totp/');
    expect(data.backupCodes).toHaveLength(10);

    const code = await createOTP(data.secret, { digits: 6, period: 30 }).totp();
    const activate = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/activate',
      token,
      body: { code },
    });
    expect(activate.status).toBe(204);
    return data;
  }

  it('challenges at sign-in and completes with a TOTP code', async () => {
    const email = await signUpVerified('mfa');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;
    const { secret } = await enrol(token);

    const challenged = await signIn(email);
    expect(challenged.status).toBe(200);
    const challenge = challenged.body['data'] as { status: string; challengeToken: string };
    expect(challenge.status).toBe('mfa_required');
    // No session is issued yet: a correct password alone must not be enough.
    expect(JSON.stringify(challenged.body)).not.toContain('"token"');

    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const verified = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken: challenge.challengeToken, code },
    });
    expect(verified.status).toBe(200);
    expect((verified.body['data'] as { status: string }).status).toBe('signed_in');
  });

  it('accepts a backup code once', async () => {
    const email = await signUpVerified('mfa-backup');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;
    const { backupCodes } = await enrol(token);
    const code = backupCodes[0]!;

    const first = await signIn(email);
    const firstChallenge = (first.body['data'] as { challengeToken: string }).challengeToken;
    const used = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      // Lowercased and with the separator stripped, as somebody reading it off
      // paper would type it.
      body: { challengeToken: firstChallenge, code: code.toLowerCase().replace('-', '') },
    });
    expect(used.status).toBe(200);

    const second = await signIn(email);
    const secondChallenge = (second.body['data'] as { challengeToken: string }).challengeToken;
    const reused = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken: secondChallenge, code },
    });
    expect(reused.status).toBe(401);
  });

  it('refuses a wrong code and a reused challenge token', async () => {
    const email = await signUpVerified('mfa-wrong');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;
    const { secret } = await enrol(token);

    const challenged = await signIn(email);
    const challengeToken = (challenged.body['data'] as { challengeToken: string }).challengeToken;

    const wrong = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken, code: '000000' },
    });
    expect(wrong.status).toBe(401);

    // The challenge token was consumed by that attempt, so the correct code
    // cannot rescue it — a guessing run gets one try per password submission.
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const late = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken, code },
    });
    expect(late.status).toBe(400);
  });

  it('blocks access until enrolment when the workspace requires MFA (M1 acceptance)', async () => {
    const email = await signUpVerified('mfa-required');
    const signedIn = (await signIn(email)).body['data'] as { token: string; tenantId: string };

    await harness.fixtures.setTenantSettings(signedIn.tenantId, { mfaRequired: true });

    const blocked = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: signedIn.token,
    });
    expect(blocked.status).toBe(403);
    expect((blocked.body['error'] as { code: string }).code).toBe('MFA_ENROLMENT_REQUIRED');

    // The routes that let them comply are still reachable, or the requirement
    // would lock everyone out with no way back in.
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token: signedIn.token,
    });
    expect(enrolment.status).toBe(201);
    const secret = (enrolment.body['data'] as { secret: string }).secret;

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/activate',
      token: signedIn.token,
      body: { code: await createOTP(secret, { digits: 6, period: 30 }).totp() },
    });

    const allowed = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: signedIn.token,
    });
    expect(allowed.status).toBe(200);
  });

  it('requires the password to turn MFA off', async () => {
    const email = await signUpVerified('mfa-off');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;
    await enrol(token);

    const wrong = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      token,
      body: { password: 'not-the-password' },
    });
    expect(wrong.status).toBe(401);

    const right = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      token,
      body: { password: PASSWORD },
    });
    expect(right.status).toBe(204);

    // Back to a single-step sign-in.
    const after = await signIn(email);
    expect((after.body['data'] as { status: string }).status).toBe('signed_in');
  });
});

describe('profile', () => {
  it('reports the workspaces the user belongs to', async () => {
    const email = await signUpVerified('me');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;

    const me = await request(harness, { method: 'GET', url: '/api/v1/auth/me', token });
    expect(me.status).toBe(200);
    const data = me.body['data'] as {
      email: string;
      emailVerified: boolean;
      memberships: { roleName: string }[];
    };
    expect(data.email).toBe(email);
    expect(data.emailVerified).toBe(true);
    expect(data.memberships[0]?.roleName).toBe('Owner');
  });

  it('signs out and invalidates the session', async () => {
    const email = await signUpVerified('signout');
    const token = ((await signIn(email)).body['data'] as { token: string }).token;

    expect(
      (await request(harness, { method: 'POST', url: '/api/v1/auth/sign-out', token })).status,
    ).toBe(204);
    expect((await request(harness, { method: 'GET', url: '/api/v1/auth/me', token })).status).toBe(
      401,
    );
  });
});
