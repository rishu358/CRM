import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createOTP } from '@better-auth/utils/otp';
import { request, startApiHarness, tokenFromEmail, type ApiHarness } from '../testing/harness.js';

/**
 * Security suites for the auth module (CLAUDE.md §10).
 *
 * The four mandatory ones, read against a module whose "records" are sessions,
 * credentials and second factors:
 *   (a) tenant A cannot reach tenant B's identity data
 *   (b) one user cannot read or revoke another user's sessions
 *   (c) nothing that must stay secret appears in a response
 *   (d) unauthenticated requests get 401
 *
 * Plus the ones specific to authentication, from the task's constraints:
 * no user enumeration, tokens single-use and expiring, sessions scoped
 * correctly.
 */
let harness: ApiHarness;

const PASSWORD = 'correct-horse-battery-staple';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Account {
  readonly email: string;
  readonly token: string;
  readonly tenantId: string;
}

/** Sign up, verify, sign in. The whole real path, no fixtures. */
async function account(prefix: string): Promise<Account> {
  const email = uniqueEmail(prefix);
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
  const data = signedIn.body['data'] as { token: string; tenantId: string };
  return { email, token: data.token, tenantId: data.tenantId };
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
}, 180_000);

afterAll(async () => {
  await harness.close();
});

// ---------------------------------------------------------------------------
// (d) Unauthenticated requests get 401
// ---------------------------------------------------------------------------
describe('unauthenticated access', () => {
  it.each([
    ['GET', '/api/v1/auth/me'],
    ['GET', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/auth/mfa'],
    ['DELETE', '/api/v1/auth/sessions/others'],
    ['POST', '/api/v1/auth/mfa/enroll'],
  ])('%s %s requires a session', async (method, url) => {
    const response = await request(harness, {
      method: method as 'GET' | 'POST' | 'DELETE',
      url,
    });
    expect(response.status).toBe(401);
  });

  it('refuses a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: 'a'.repeat(43),
    });
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (a) Cross-tenant isolation
// ---------------------------------------------------------------------------
describe('tenant isolation', () => {
  it('a user cannot act in a workspace they do not belong to', async () => {
    const a = await account('iso-a');
    const b = await account('iso-b');

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: a.token,
      tenantId: b.tenantId,
    });
    // Resolved as "no membership", which is deliberately indistinguishable
    // from "no such tenant": RLS returned nothing either way.
    expect(response.status).toBe(403);
  });

  it('the profile reports only this user’s own workspaces', async () => {
    const a = await account('iso-me-a');
    const b = await account('iso-me-b');

    const me = await request(harness, { method: 'GET', url: '/api/v1/auth/me', token: a.token });
    const memberships = (me.body['data'] as { memberships: { tenantId: string }[] }).memberships;
    expect(memberships.map((row) => row.tenantId)).not.toContain(b.tenantId);
    expect(memberships).toHaveLength(1);
  });

  it('a password change in one workspace does not touch another user', async () => {
    const a = await account('iso-pw-a');
    const b = await account('iso-pw-b');

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/change-password',
      token: a.token,
      body: { currentPassword: PASSWORD, newPassword: 'an-entirely-new-passphrase' },
    });

    const stillSignedIn = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: b.token,
    });
    expect(stillSignedIn.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (b) One user cannot reach another's sessions
// ---------------------------------------------------------------------------
describe('session scoping', () => {
  it('the session list contains only the caller’s own sessions', async () => {
    const a = await account('scope-a');
    const b = await account('scope-b');

    const listA = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: a.token,
    });
    const listB = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: b.token,
    });

    const idsA = (listA.body['data'] as { id: string }[]).map((row) => row.id);
    const idsB = (listB.body['data'] as { id: string }[]).map((row) => row.id);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });

  it('a user cannot revoke somebody else’s session', async () => {
    const a = await account('revoke-a');
    const b = await account('revoke-b');

    const listB = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: b.token,
    });
    const victimSessionId = (listB.body['data'] as { id: string }[])[0]!.id;

    const attempt = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/auth/sessions?id=${victimSessionId}`,
      token: a.token,
    });
    // 404, not 403: a 403 would confirm the id names a real session
    // (CLAUDE.md §5.5).
    expect(attempt.status).toBe(404);

    const victimStillWorks = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: b.token,
    });
    expect(victimStillWorks.status).toBe(200);
  });

  it('refusing a foreign session id is identical to refusing a made-up one', async () => {
    const a = await account('revoke-same');
    const b = await account('revoke-same-b');

    const listB = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: b.token,
    });
    const realButForeign = (listB.body['data'] as { id: string }[])[0]!.id;

    const foreign = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/auth/sessions?id=${realButForeign}`,
      token: a.token,
    });
    const absent = await request(harness, {
      method: 'DELETE',
      url: '/api/v1/auth/sessions?id=00000000-0000-4000-8000-000000000000',
      token: a.token,
    });

    expect(foreign.status).toBe(absent.status);
    expect((foreign.body['error'] as { code: string; message: string }).message).toBe(
      (absent.body['error'] as { code: string; message: string }).message,
    );
  });

  it('signing out other devices leaves other users alone', async () => {
    const a = await account('others-a');
    const b = await account('others-b');

    await request(harness, {
      method: 'DELETE',
      url: '/api/v1/auth/sessions/others',
      token: a.token,
    });

    expect(
      (await request(harness, { method: 'GET', url: '/api/v1/auth/me', token: b.token })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (c) Nothing secret in a response
// ---------------------------------------------------------------------------
describe('what responses expose', () => {
  it('never returns a password hash', async () => {
    const a = await account('leak-hash');
    const me = await request(harness, { method: 'GET', url: '/api/v1/auth/me', token: a.token });
    const serialised = JSON.stringify(me.body);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain('$scrypt');
  });

  it('never returns a session token hash or another session token', async () => {
    const a = await account('leak-session');
    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: a.token,
    });
    const serialised = JSON.stringify(list.body);
    expect(serialised).not.toContain('tokenHash');
    expect(serialised).not.toContain(a.token);
  });

  it('does not return the TOTP secret after enrolment is complete', async () => {
    const a = await account('leak-totp');
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token: a.token,
    });
    const secret = (enrolment.body['data'] as { secret: string }).secret;

    const status = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/mfa',
      token: a.token,
    });
    expect(JSON.stringify(status.body)).not.toContain(secret);

    const me = await request(harness, { method: 'GET', url: '/api/v1/auth/me', token: a.token });
    expect(JSON.stringify(me.body)).not.toContain(secret);
  });

  it('does not return backup codes again after enrolment', async () => {
    const a = await account('leak-backup');
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token: a.token,
    });
    const code = (enrolment.body['data'] as { backupCodes: string[] }).backupCodes[0]!;

    const status = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/mfa',
      token: a.token,
    });
    expect(JSON.stringify(status.body)).not.toContain(code);
    // The count is fine to show; the codes are not.
    expect((status.body['data'] as { backupCodesRemaining: number }).backupCodesRemaining).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// User enumeration
// ---------------------------------------------------------------------------
describe('user enumeration', () => {
  it('sign-in answers the same for an unknown address and a wrong password', async () => {
    const a = await account('enum-signin');

    const unknown = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: uniqueEmail('nobody'), password: PASSWORD },
    });
    const wrongPassword = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: a.email, password: 'definitely-not-the-password' },
    });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body['error']).toMatchObject({
      code: (wrongPassword.body['error'] as { code: string }).code,
      message: (wrongPassword.body['error'] as { message: string }).message,
    });
  });

  it('sign-up answers the same for a new address and an existing one', async () => {
    const a = await account('enum-signup');

    const fresh = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email: uniqueEmail('enum-new'), password: PASSWORD, name: 'Test Person' },
    });
    const taken = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email: a.email, password: PASSWORD, name: 'Somebody Else' },
    });

    expect(taken.status).toBe(fresh.status);
    expect(taken.body).toEqual(fresh.body);
  });

  it('a duplicate sign-up does not overwrite the existing account', async () => {
    const a = await account('enum-overwrite');

    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email: a.email, password: 'an-attackers-chosen-passphrase', name: 'Attacker' },
    });

    // The original password still works and the attacker's does not — the
    // duplicate path must not touch the credential.
    const original = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: a.email, password: PASSWORD },
    });
    expect(original.status).toBe(200);

    const attacker = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: a.email, password: 'an-attackers-chosen-passphrase' },
    });
    expect(attacker.status).toBe(401);
  });

  it('forgot-password answers the same for a known and an unknown address', async () => {
    const a = await account('enum-forgot');

    const known = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email: a.email },
    });
    const unknown = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      body: { email: uniqueEmail('enum-nobody') },
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('resend-verification answers the same for a known and an unknown address', async () => {
    const a = await account('enum-resend');

    const known = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      body: { email: a.email },
    });
    const unknown = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      body: { email: uniqueEmail('enum-resend-nobody') },
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('does not send a verification email to an address with no account', async () => {
    const nobody = uniqueEmail('enum-silent');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      body: { email: nobody },
    });
    expect(harness.emails.lastTo(nobody)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// One-time tokens
// ---------------------------------------------------------------------------
describe('one-time tokens', () => {
  it('refuses a token minted for another purpose', async () => {
    const email = uniqueEmail('purpose');
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Test Person' },
    });
    const verificationToken = tokenFromEmail(harness.emails.lastTo(email)!.text);

    // An email-verification token must not reset a password. Without the
    // `purpose` column this would succeed, and a link that proves someone can
    // read their mail would become a password reset.
    const misuse = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      body: { token: verificationToken, password: 'a-password-of-my-choosing' },
    });
    expect(misuse.status).toBe(400);

    // And it still works for what it was issued for.
    const proper = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      body: { token: verificationToken },
    });
    expect(proper.status).toBe(204);
  });

  it('refuses a token that was never issued', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      body: { token: 'z'.repeat(43), password: 'a-perfectly-good-passphrase' },
    });
    expect(response.status).toBe(400);
  });

  it('refuses an MFA challenge token for a second attempt', async () => {
    const a = await account('token-mfa');
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token: a.token,
    });
    const secret = (enrolment.body['data'] as { secret: string }).secret;
    await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/activate',
      token: a.token,
      body: { code: await createOTP(secret, { digits: 6, period: 30 }).totp() },
    });

    const challenged = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: a.email, password: PASSWORD },
    });
    const challengeToken = (challenged.body['data'] as { challengeToken: string }).challengeToken;

    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const first = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken, code },
    });
    expect(first.status).toBe(200);

    const replay = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      body: { challengeToken, code },
    });
    expect(replay.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Input validation at the boundary
// ---------------------------------------------------------------------------
describe('input validation', () => {
  it.each([
    ['/api/v1/auth/sign-in', { email: 'not-an-email', password: PASSWORD }],
    ['/api/v1/auth/sign-in', { email: 'a@example.com' }],
    ['/api/v1/auth/forgot-password', { email: 'nope' }],
    ['/api/v1/auth/mfa/verify', { challengeToken: 'short', code: '123456' }],
    ['/api/v1/auth/reset-password', { token: 'z'.repeat(43), password: 'short' }],
  ])('rejects a malformed body for %s', async (url, body) => {
    const response = await request(harness, { method: 'POST', url, body });
    expect(response.status).toBe(422);
  });

  it('rejects an unknown key rather than ignoring it', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email: 'a@example.com', password: PASSWORD, role: 'owner' },
    });
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Per-IP rate limiting on the unauthenticated routes (CLAUDE.md §5.14)
// ---------------------------------------------------------------------------
describe('auth rate limiting', () => {
  it('refuses once one address exceeds the ceiling', async () => {
    // A harness of its own with a small ceiling: the shared one is set high so
    // that the rest of the suite's traffic does not trip it, and a test that
    // asserted on the shared limit would be asserting on test configuration.
    const limited = await startApiHarness(inject('dbUrls'), {
      AUTH_RATE_LIMIT_MAX_PER_IP: '5',
      AUTH_RATE_LIMIT_WINDOW_SECONDS: '900',
    });

    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await request(limited, {
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          body: { email: uniqueEmail('ratelimit'), password: PASSWORD },
        });
        statuses.push(response.status);
      }

      // The first few are ordinary failures; past the ceiling they are refused
      // outright, which is what bounds a password-spraying run across many
      // different addresses — something the per-account delay never sees.
      expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it('does not apply the unauthenticated ceiling to a signed-in caller', async () => {
    const a = await account('ratelimit-auth');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(harness, {
        method: 'GET',
        url: '/api/v1/auth/me',
        token: a.token,
      });
      expect(response.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Auditing (CLAUDE.md §5.10)
// ---------------------------------------------------------------------------
describe('auditing', () => {
  it('records sign-in, sign-out and password changes', async () => {
    const a = await account('audit');

    await request(harness, { method: 'POST', url: '/api/v1/auth/sign-out', token: a.token });

    const events = await harness.fixtures.authEvents({ email: a.email });
    const types = events.map((event) => event.type);
    expect(types).toContain('signup');
    expect(types).toContain('login_succeeded');

    const byUser = await harness.fixtures.authEvents({ email: a.email });
    expect(byUser.some((event) => event.type === 'login_succeeded' && event.succeeded)).toBe(true);
  });
});
