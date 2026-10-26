import { hashPassword as legacyHash } from 'better-auth/crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { request, startApiHarness, tokenFromEmail, type ApiHarness } from '../testing/harness.js';
import { AuthRepository } from './auth.repository.js';

/**
 * Passwords move to Argon2id as their owners sign in (ADR-0050), against a real database and the real
 * sign-in route: an old hash still works and is replaced, a wrong password changes nothing, an upgrade
 * can never undo a password change, and failing to upgrade never fails a sign-in.
 */
let harness: ApiHarness;
let stronger: ApiHarness;
let superuser: pg.Pool;

const PASSWORD = 'correct-horse-battery-staple';

const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

async function account(
  app: ApiHarness,
  prefix: string,
): Promise<{ email: string; userId: string }> {
  const email = unique(prefix);
  const signUp = await request(app, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Test Person' },
  });
  expect(signUp.status).toBe(202);
  await request(app, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(app.emails.lastTo(email)!.text) },
  });
  const user = await superuser.query<{ id: string }>('select id from users where email = $1', [
    email,
  ]);
  return { email, userId: (user.rows[0] as { id: string }).id };
}

async function storedHash(userId: string): Promise<string> {
  const result = await superuser.query<{ password_hash: string }>(
    `select password_hash from auth_accounts where user_id = $1 and provider_id = 'credential'`,
    [userId],
  );
  return (result.rows[0] as { password_hash: string }).password_hash;
}

async function setHash(userId: string, hash: string): Promise<void> {
  await superuser.query(
    `update auth_accounts set password_hash = $1 where user_id = $2 and provider_id = 'credential'`,
    [hash, userId],
  );
}

const signIn = (app: ApiHarness, email: string, password = PASSWORD) =>
  request(app, { method: 'POST', url: '/api/v1/auth/sign-in', body: { email, password } });

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  stronger = await startApiHarness(urls, { PASSWORD_HASH_MEMORY_KIB: '32768' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
}, 240_000);

afterAll(async () => {
  await superuser.end();
  await harness.close();
  await stronger.close();
});

describe('a new account', () => {
  it('is stored as Argon2id from the start', async () => {
    const { userId } = await account(harness, 'fresh');
    expect(await storedHash(userId)).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});

describe('an account with an old (scrypt) hash', () => {
  it('signs in, and the hash is replaced by an Argon2id one of the same password', async () => {
    const { email, userId } = await account(harness, 'legacy');
    const legacy = await legacyHash(PASSWORD);
    await setHash(userId, legacy);

    const response = await signIn(harness, email);
    expect(response.status).toBe(200);

    const after = await storedHash(userId);
    expect(after).toMatch(/^\$argon2id\$/);
    expect(after).not.toBe(legacy);
    // Still the same password.
    expect((await signIn(harness, email)).status).toBe(200);
    expect((await signIn(harness, email, 'not-the-password')).status).toBe(401);
  });

  it('is rewritten once, not on every sign-in', async () => {
    const { email, userId } = await account(harness, 'once');
    await setHash(userId, await legacyHash(PASSWORD));
    await signIn(harness, email);
    const upgraded = await storedHash(userId);
    await signIn(harness, email);
    await signIn(harness, email);
    expect(await storedHash(userId)).toBe(upgraded);
  });

  it('is left exactly as it was when the password is wrong', async () => {
    const { email, userId } = await account(harness, 'wrong');
    const legacy = await legacyHash(PASSWORD);
    await setHash(userId, legacy);

    expect((await signIn(harness, email, 'not-the-password')).status).toBe(401);
    expect(await storedHash(userId)).toBe(legacy);
  });

  it('does not sign anyone out: the upgrade is not a password change', async () => {
    const { email, userId } = await account(harness, 'sessions');
    const first = await signIn(harness, email);
    const token = (first.body['data'] as { token: string }).token;

    await setHash(userId, await legacyHash(PASSWORD));
    expect((await signIn(harness, email)).status).toBe(200);
    expect(await storedHash(userId)).toMatch(/^\$argon2id\$/);

    const stillValid = await request(harness, { method: 'GET', url: '/api/v1/auth/mfa', token });
    expect(stillValid.status).toBe(200);
  });
});

describe('raising the cost', () => {
  it('upgrades an Argon2id hash made at the lower setting at the owner’s next sign-in', async () => {
    const { email, userId } = await account(harness, 'raise');
    expect(await storedHash(userId)).toContain('m=19456,');

    expect((await signIn(stronger, email)).status).toBe(200);
    expect(await storedHash(userId)).toContain('m=32768,');

    // And the application still running the lower setting never weakens it again.
    expect((await signIn(harness, email)).status).toBe(200);
    expect(await storedHash(userId)).toContain('m=32768,');
  });
});

describe('what the upgrade must never do', () => {
  it('undo a password change made between the check and the write', async () => {
    const { userId } = await account(harness, 'race');
    const repository = harness.app.get(AuthRepository);
    const verified = await storedHash(userId);

    // The owner changes their password after the sign-in verified `verified` and before it wrote.
    const changed = await legacyHash('a-newly-chosen-password-1');
    await setHash(userId, changed);

    const replaced = await repository.upgradePasswordHash(userId, verified, '$argon2id$stale');
    expect(replaced).toBe(false);
    expect(await storedHash(userId)).toBe(changed);
  });

  it('fail a sign-in the person has just passed', async () => {
    const { email, userId } = await account(harness, 'resilient');
    const legacy = await legacyHash(PASSWORD);
    await setHash(userId, legacy);

    const repository = harness.app.get(AuthRepository);
    const spy = vi
      .spyOn(repository, 'upgradePasswordHash')
      .mockRejectedValueOnce(new Error('database went away'));
    try {
      expect((await signIn(harness, email)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    // Unchanged, and tried again next time.
    expect(await storedHash(userId)).toBe(legacy);
    expect((await signIn(harness, email)).status).toBe(200);
    expect(await storedHash(userId)).toMatch(/^\$argon2id\$/);
  });
});

describe('changing a password', () => {
  it('always writes the current format, whatever the old hash was', async () => {
    const { email, userId } = await account(harness, 'change');
    await setHash(userId, await legacyHash(PASSWORD));
    const token = ((await signIn(harness, email)).body['data'] as { token: string }).token;

    const changed = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/change-password',
      token,
      body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password-42' },
    });
    expect(changed.status).toBe(200);
    expect(await storedHash(userId)).toMatch(/^\$argon2id\$v=19\$m=19456,/);
    expect((await signIn(harness, email, 'a-brand-new-password-42')).status).toBe(200);
    expect((await signIn(harness, email)).status).toBe(401);
  });
});

describe('configuration', () => {
  it('refuses settings weaker than the floor, naming the variable and nothing else', async () => {
    const urls = inject('dbUrls');
    await expect(startApiHarness(urls, { PASSWORD_HASH_MEMORY_KIB: '4096' })).rejects.toThrow(
      'PASSWORD_HASH_MEMORY_KIB',
    );
    await expect(startApiHarness(urls, { PASSWORD_HASH_PASSES: '1' })).rejects.toThrow(
      'PASSWORD_HASH_PASSES',
    );
  }, 240_000);
});
