import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatorCode,
  base32Bytes,
  base32Text,
  hotp,
  secretFromOtpauthUrl,
} from '../../testing/totp-reference.js';
import { KeyRing } from './key-ring.js';
import { BetterAuthTotpProvider } from './totp.provider.js';

/**
 * Two-factor codes (F1 of the pilot simulation): the key the setup page shows must be the key the
 * server checks codes against, as an authenticator app reads it.
 *
 * The expected values come from RFC 6238 Appendix B (HMAC-SHA1, shared secret "12345678901234567890"),
 * cut to the last six digits as an app with six-digit codes shows them, and from an independent
 * implementation in `testing/totp-reference.ts` (not from the code under test).
 */
const KEY = 'totp-spec-key-0123456789abcdefghijklmnopqrstuvwxyz';
const RFC_SECRET = base32Text(Buffer.from('12345678901234567890', 'ascii'));

const RFC_VECTORS: ReadonlyArray<{ unixSeconds: number; code: string }> = [
  { unixSeconds: 59, code: '287082' },
  { unixSeconds: 1_111_111_109, code: '081804' },
  { unixSeconds: 1_111_111_111, code: '050471' },
  { unixSeconds: 1_234_567_890, code: '005924' },
  { unixSeconds: 2_000_000_000, code: '279037' },
  { unixSeconds: 20_000_000_000, code: '353130' },
];

function provider(): BetterAuthTotpProvider {
  return new BetterAuthTotpProvider(new KeyRing(KEY));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the reference implementation used by these tests', () => {
  it('matches RFC 4226 Appendix D (the HOTP test values)', () => {
    const key = Buffer.from('12345678901234567890', 'ascii');
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Text(bytes)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Bytes('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(bytes)).toBe(true);
  });
});

describe('verifying a code from the key an authenticator app was given', () => {
  it.each(RFC_VECTORS)('accepts the RFC 6238 code $code at unix time $unixSeconds', async (v) => {
    vi.useFakeTimers({ now: v.unixSeconds * 1000 });
    const totp = provider();
    expect(await totp.verify(totp.toStoredSecret(RFC_SECRET), v.code)).toBe(true);
  });

  it('refuses the same codes at a time that is not theirs', async () => {
    vi.useFakeTimers({ now: 1_111_111_109_000 + 5 * 30_000 });
    const totp = provider();
    expect(await totp.verify(totp.toStoredSecret(RFC_SECRET), '081804')).toBe(false);
  });

  it('accepts a freshly generated key read as base32, which is what the page shows', async () => {
    const totp = provider();
    const secret = totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const code = authenticatorCode(secret);
    expect(await totp.verify(totp.toStoredSecret(secret), code)).toBe(true);
  });

  it('accepts a code with the space an authenticator app shows in the middle', async () => {
    const totp = provider();
    const secret = totp.generateSecret();
    const code = authenticatorCode(secret);
    expect(
      await totp.verify(totp.toStoredSecret(secret), `${code.slice(0, 3)} ${code.slice(3)}`),
    ).toBe(true);
  });

  it('refuses a wrong code, a short code, and text', async () => {
    const totp = provider();
    const stored = totp.toStoredSecret(RFC_SECRET);
    vi.useFakeTimers({ now: 59_000 });
    expect(await totp.verify(stored, '000000')).toBe(false);
    expect(await totp.verify(stored, '28708')).toBe(false);
    expect(await totp.verify(stored, '2870822')).toBe(false);
    expect(await totp.verify(stored, 'abcdef')).toBe(false);
    expect(await totp.verify(stored, '')).toBe(false);
  });
});

describe('the clock window is one 30-second step either side, no more', () => {
  const NOW = 1_700_000_000_000;

  it.each([
    [-1, true],
    [0, true],
    [1, true],
    [-2, false],
    [2, false],
    [-10, false],
  ])('a code %i steps away from now is accepted: %s', async (stepOffset, accepted) => {
    vi.useFakeTimers({ now: NOW });
    const totp = provider();
    const stored = totp.toStoredSecret(RFC_SECRET);
    const code = authenticatorCode(RFC_SECRET, { atMs: NOW, stepOffset });
    expect(await totp.verify(stored, code)).toBe(accepted);
  });
});

describe('the setup link', () => {
  it('carries the same key the page shows, and the settings the server checks with', () => {
    const totp = provider();
    const secret = totp.generateSecret();
    const url = new URL(totp.provisioningUrl(secret, 'Acme CRM', 'asha@example.com'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Acme CRM:asha@example.com');
    expect(secretFromOtpauthUrl(url.toString())).toBe(secret);
    expect(url.searchParams.get('issuer')).toBe('Acme CRM');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
  });
});

describe('keys stored before this fix', () => {
  /**
   * Until the fix the server used the characters of the base32 text as the key. A person who had
   * enrolled with the QR link has an app holding the base32 of that text. Their stored value has no
   * marker, and must keep working until they set two-factor up again.
   */
  it('still verify, each by its own rule, and only by that rule', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const totp = provider();
    const legacyText = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // What the old QR link put in the app: base32 of the text.
    const appKey = base32Text(Buffer.from(legacyText, 'utf8'));
    expect(await totp.verify(legacyText, authenticatorCode(appKey))).toBe(true);
    // A code made from the text read as base32 does not work on an old key (that was the bug), and
    // the old key's code does not work on a new one.
    expect(await totp.verify(legacyText, authenticatorCode(legacyText))).toBe(false);
    expect(await totp.verify(totp.toStoredSecret(legacyText), authenticatorCode(appKey))).toBe(
      false,
    );
  });
});

describe('what is stored', () => {
  it('is encrypted under the key ring, and reads back as what was stored', async () => {
    const totp = provider();
    const secret = totp.generateSecret();
    const stored = totp.toStoredSecret(secret);
    const ciphertext = await totp.encryptSecret(stored);
    expect(ciphertext).not.toContain(secret);
    expect(await totp.decryptSecret(ciphertext)).toBe(stored);
  });
});
