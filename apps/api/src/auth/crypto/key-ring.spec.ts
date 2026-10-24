import { symmetricEncrypt } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import { KeyRing, UndecryptableError, UnknownKeyError, keyId } from './key-ring.js';

/**
 * The key ring (ADR-0049): every stored value says which key wrote it, so a key can be rotated
 * without making what it encrypted unreadable.
 */
const KEY_A = 'key-A-0123456789abcdefghijklmnopqrstuvwxyz';
const KEY_B = 'key-B-0123456789abcdefghijklmnopqrstuvwxyz';
const KEY_C = 'key-C-0123456789abcdefghijklmnopqrstuvwxyz';

describe('keyId', () => {
  it('is eight hex characters, stable, and different for different keys', () => {
    expect(keyId(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyId(KEY_A)).toBe(keyId(KEY_A));
    expect(keyId(KEY_A)).not.toBe(keyId(KEY_B));
  });

  it('does not contain the key', () => {
    expect(KEY_A).not.toContain(keyId(KEY_A));
    expect(keyId(KEY_A)).not.toContain('key-A');
  });
});

describe('encrypting and decrypting', () => {
  it('writes the current key’s id in front of the ciphertext, and reads it back', async () => {
    const ring = new KeyRing(KEY_A);
    const stored = await ring.encrypt('JBSWY3DPEHPK3PXP');
    expect(stored.startsWith(`k1.${keyId(KEY_A)}.`)).toBe(true);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await ring.decrypt(stored)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never writes the same ciphertext twice', async () => {
    const ring = new KeyRing(KEY_A);
    expect(await ring.encrypt('same')).not.toBe(await ring.encrypt('same'));
  });

  it('reads what an earlier key wrote, once that key is kept as a previous one', async () => {
    const before = await new KeyRing(KEY_A).encrypt('secret-one');
    const after = new KeyRing(KEY_B, [KEY_A]);
    expect(await after.decrypt(before)).toBe('secret-one');
    // And writes under the new one.
    expect((await after.encrypt('secret-two')).startsWith(`k1.${keyId(KEY_B)}.`)).toBe(true);
  });

  it('reads a value from before key ids existed, with the current key or a previous one', async () => {
    const legacyUnderA = await symmetricEncrypt({ key: KEY_A, data: 'old-secret' });
    expect(legacyUnderA).not.toContain('.');
    expect(await new KeyRing(KEY_A).decrypt(legacyUnderA)).toBe('old-secret');
    expect(await new KeyRing(KEY_B, [KEY_A]).decrypt(legacyUnderA)).toBe('old-secret');
    expect(await new KeyRing(KEY_C, [KEY_B, KEY_A]).decrypt(legacyUnderA)).toBe('old-secret');
  });
});

describe('what it refuses', () => {
  it('names the key id, and only the id, when a value’s key is not held', async () => {
    const stored = await new KeyRing(KEY_A).encrypt('x');
    const ring = new KeyRing(KEY_B);
    const error = await ring.decrypt(stored).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownKeyError);
    expect((error as UnknownKeyError).id).toBe(keyId(KEY_A));
    expect(String(error)).not.toContain(KEY_A);
    expect(String(error)).not.toContain(KEY_B);
    expect(String(error)).toContain('AUTH_SECRET_PREVIOUS');
  });

  it('fails an old-format value that no held key opens, without saying which key it tried', async () => {
    const legacy = await symmetricEncrypt({ key: KEY_A, data: 'x' });
    const error = await new KeyRing(KEY_B, [KEY_C]).decrypt(legacy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UndecryptableError);
    expect(String(error)).not.toContain(KEY_A);
  });

  it('fails a tampered value rather than returning something', async () => {
    const ring = new KeyRing(KEY_A);
    const stored = await ring.encrypt('secret');
    const last = stored.slice(-1) === '0' ? '1' : '0';
    await expect(ring.decrypt(stored.slice(0, -1) + last)).rejects.toBeInstanceOf(
      UndecryptableError,
    );
    // A value under a held key id whose body belongs to another key is also refused.
    const other = await new KeyRing(KEY_B).encrypt('secret');
    const forged = `k1.${keyId(KEY_A)}.${other.split('.')[2] as string}`;
    await expect(ring.decrypt(forged)).rejects.toBeInstanceOf(UndecryptableError);
  });

  it('refuses a ring that holds the same key twice', () => {
    expect(() => new KeyRing(KEY_A, [KEY_A])).toThrow('must all be different keys');
    expect(() => new KeyRing(KEY_A, [KEY_B, KEY_B])).toThrow('must all be different keys');
  });
});

describe('what needs rotating', () => {
  it('is anything not in the current format under the current key', async () => {
    const underA = await new KeyRing(KEY_A).encrypt('x');
    const legacy = await symmetricEncrypt({ key: KEY_A, data: 'x' });
    const ring = new KeyRing(KEY_B, [KEY_A]);
    const current = await ring.encrypt('x');

    expect(ring.needsRotation(current)).toBe(false);
    expect(ring.needsRotation(underA)).toBe(true);
    expect(ring.needsRotation(legacy)).toBe(true);
    // Even under the current key, the old format is rotated into the new one.
    expect(new KeyRing(KEY_A).needsRotation(legacy)).toBe(true);
  });

  it('reports which key a value is under, for the operator', async () => {
    const ring = new KeyRing(KEY_B, [KEY_A]);
    expect(ring.idOf(await ring.encrypt('x'))).toBe(ring.currentId);
    expect(ring.idOf(await new KeyRing(KEY_A).encrypt('x'))).toBe(keyId(KEY_A));
    expect(ring.idOf(await symmetricEncrypt({ key: KEY_A, data: 'x' }))).toBe('legacy');
    expect(ring.secrets()).toEqual([KEY_B, KEY_A]);
  });
});
