import { describe, expect, it } from 'vitest';
import { newId } from '../ids/index.js';
import {
  BACKUP_CODE_COUNT,
  findBackupCode,
  generateBackupCodes,
  hashBackupCode,
  hashBackupCodes,
  normaliseBackupCode,
} from './backup-codes.js';
import {
  PASSWORD_MIN_LENGTH,
  emailSchema,
  passwordProblems,
  passwordSchema,
} from './password-policy.js';
import { FAILURE_THRESHOLD, isThrottled, throttleDelayMs } from './throttle.js';
import {
  TOKEN_TTL_SECONDS,
  generateInvitationToken,
  generateOneTimeToken,
  hashOneTimeToken,
  parseInvitationToken,
  secretsMatch,
} from './tokens.js';

describe('password policy', () => {
  it('requires length over composition', () => {
    expect(passwordProblems('a-long-enough-passphrase')).toEqual([]);
    expect(passwordProblems('Sh0rt!')).toContain(
      `Use at least ${String(PASSWORD_MIN_LENGTH)} characters`,
    );
  });

  it('rejects a single character class below 20 characters', () => {
    expect(passwordProblems('aaaaaaaaaaaaaa').length).toBeGreaterThan(0);
    expect(passwordProblems('123456789012345')).not.toEqual([]);
    // Long enough that a single class is fine: a real passphrase.
    expect(passwordProblems('correcthorsebatterystaple')).toEqual([]);
  });

  it('rejects well-known passwords regardless of shape', () => {
    expect(passwordProblems('password123')).toContain('This password is too common');
  });

  it('caps the length so hashing cannot be weaponised', () => {
    expect(passwordSchema.safeParse('a'.repeat(5000)).success).toBe(false);
  });

  it('normalises email addresses', () => {
    expect(emailSchema.parse('  Priya.Nair@Example.COM ')).toBe('priya.nair@example.com');
    expect(emailSchema.safeParse('not-an-address').success).toBe(false);
  });
});

describe('brute-force back-off', () => {
  it('does nothing below the threshold', () => {
    for (let failures = 0; failures < FAILURE_THRESHOLD; failures += 1) {
      expect(throttleDelayMs(failures)).toBe(0);
      expect(isThrottled(failures)).toBe(false);
    }
  });

  it('engages at the fifth failure (M1 acceptance)', () => {
    expect(isThrottled(FAILURE_THRESHOLD)).toBe(true);
    expect(throttleDelayMs(FAILURE_THRESHOLD)).toBeGreaterThan(0);
  });

  it('grows with each further failure, then flattens at the cap', () => {
    expect(throttleDelayMs(6)).toBeGreaterThan(throttleDelayMs(5));
    expect(throttleDelayMs(7)).toBeGreaterThan(throttleDelayMs(6));
    // Bounded: an unbounded delay is a request held open, which is its own
    // denial of service against us.
    expect(throttleDelayMs(100, 8000)).toBe(8000);
    expect(throttleDelayMs(1000, 8000)).toBe(8000);
  });

  it('honours a custom cap', () => {
    expect(throttleDelayMs(50, 50)).toBe(50);
  });
});

describe('backup codes', () => {
  it('generates the requested number, all distinct', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
  });

  it('avoids characters that are read wrong off a printout', () => {
    for (const code of generateBackupCodes(50)) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('matches however the user types it', () => {
    const code = 'A2C4-E6G8';
    const hashes = hashBackupCodes([code]);
    for (const typed of ['A2C4-E6G8', 'a2c4-e6g8', 'A2C4E6G8', 'a2c4 e6g8', ' A2C4-e6G8 ']) {
      expect(findBackupCode(hashes, typed)).toBe(0);
    }
  });

  it('does not match a different code', () => {
    expect(findBackupCode(hashBackupCodes(['A2C4-E6G8']), 'A2C4-E6G9')).toBeNull();
  });

  it('stores digests, not the codes', () => {
    const code = 'A2C4-E6G8';
    const hash = hashBackupCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normaliseBackupCode(code));
  });
});

describe('one-time tokens', () => {
  it('produces high-entropy tokens that never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOneTimeToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('hashes to a stable SHA-256 digest', () => {
    const token = generateOneTimeToken();
    expect(hashOneTimeToken(token)).toBe(hashOneTimeToken(token));
    expect(hashOneTimeToken(token)).toMatch(/^[0-9a-f]{64}$/);
    // The digest must not contain the token: it is what goes in the database.
    expect(hashOneTimeToken(token)).not.toContain(token);
  });

  it('gives a reset link a much shorter life than a verification link', () => {
    expect(TOKEN_TTL_SECONDS.password_reset).toBeLessThan(TOKEN_TTL_SECONDS.email_verification);
    expect(TOKEN_TTL_SECONDS.mfa_challenge).toBeLessThan(TOKEN_TTL_SECONDS.password_reset);
  });

  it('compares secrets without throwing on different lengths', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});

describe('invitation tokens', () => {
  it('carries the workspace id as a prefix and a fresh secret after it', () => {
    const tenantId = newId();
    const token = generateInvitationToken(tenantId);

    const parsed = parseInvitationToken(token);
    expect(parsed?.tenantId).toBe(tenantId);
    expect(parsed?.secret.length).toBeGreaterThanOrEqual(43);

    // A second invitation to the same workspace shares only the prefix.
    expect(parseInvitationToken(generateInvitationToken(tenantId))?.secret).not.toBe(
      parsed?.secret,
    );
  });

  it('refuses anything whose prefix is not a workspace id', () => {
    // The prefix reaches `SET LOCAL app.tenant_id`, so a malformed one must be
    // rejected here rather than passed along (ADR-0018).
    expect(parseInvitationToken('not-a-uuid.' + 'a'.repeat(43))).toBeNull();
    expect(parseInvitationToken('.' + 'a'.repeat(43))).toBeNull();
    expect(parseInvitationToken('a'.repeat(80))).toBeNull();
    expect(parseInvitationToken('')).toBeNull();
  });

  it('refuses a secret too short to be one of ours', () => {
    expect(parseInvitationToken(`${newId()}.short`)).toBeNull();
  });

  it('hashes the whole token, prefix included', () => {
    const tenantId = newId();
    const token = generateInvitationToken(tenantId);
    const secret = parseInvitationToken(token)?.secret ?? '';

    // Binding the prefix into the digest means a swapped prefix fails the
    // lookup as well as landing in the wrong RLS context.
    expect(hashOneTimeToken(token)).not.toBe(hashOneTimeToken(secret));
    expect(hashOneTimeToken(token)).not.toBe(hashOneTimeToken(`${newId()}.${secret}`));
  });

  it('gives an invitation the longest life of any one-time token', () => {
    // Seven days, fixed by MVP_SPEC M2.
    expect(TOKEN_TTL_SECONDS.team_invite).toBe(7 * 24 * 60 * 60);
    expect(TOKEN_TTL_SECONDS.team_invite).toBeGreaterThan(TOKEN_TTL_SECONDS.email_verification);
  });
});
