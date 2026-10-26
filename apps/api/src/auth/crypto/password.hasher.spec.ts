import { argon2Sync } from 'node:crypto';
import { hashPassword as legacyHash } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '../../config/env.js';
import { Argon2idPasswordHasher } from './password.hasher.js';

/**
 * Password hashing (ADR-0017, ADR-0050): Argon2id for new passwords, the old scrypt format still accepted
 * and upgraded, and every odd stored value a failed sign-in rather than a crash.
 */
const settings = (memory = 19456, passes = 2, parallelism = 1) =>
  ({
    PASSWORD_HASH_MEMORY_KIB: memory,
    PASSWORD_HASH_PASSES: passes,
    PASSWORD_HASH_PARALLELISM: parallelism,
  }) as unknown as ApiEnv;

const hasher = new Argon2idPasswordHasher(settings());
const PASSWORD = 'correct horse battery staple';

describe('the primitive', () => {
  it('is Argon2id as RFC 9106 defines it (section 5.3 test vector)', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });
});

describe('hash and verify', () => {
  it('stores a PHC string that carries its own cost', async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(hash).not.toContain(PASSWORD);
  });

  it('uses a fresh salt every time', async () => {
    expect(await hasher.hash(PASSWORD)).not.toBe(await hasher.hash(PASSWORD));
  });

  it('accepts the right password and nothing else', async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, `${PASSWORD} `)).toBe(false);
    expect(await hasher.verify(hash, PASSWORD.toUpperCase())).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('handles passwords that are long, non-ASCII, or contain separators', async () => {
    for (const password of [
      'pässwörd-日本語-🔑',
      'a'.repeat(1000),
      'has$dollar$and:colons,commas',
    ]) {
      expect(await hasher.verify(await hasher.hash(password), password)).toBe(true);
    }
  });

  it('keeps verifying a hash pinned from an earlier release, so stored hashes never strand', async () => {
    const pinned =
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y';
    expect(await hasher.verify(pinned, PASSWORD)).toBe(true);
    expect(await hasher.verify(pinned, 'another password')).toBe(false);
  });

  it('verifies a hash made at other settings, by the settings it carries', async () => {
    const stronger = new Argon2idPasswordHasher(settings(32768, 3, 2));
    const hash = await stronger.hash(PASSWORD);
    expect(hash).toContain('m=32768,t=3,p=2');
    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
  });
});

describe('what it will not be fooled by', () => {
  it.each([
    ['empty', ''],
    ['prefix only', '$argon2id$'],
    [
      'wrong variant',
      '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    [
      'old version',
      '$argon2id$v=16$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    ['no tag', '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$'],
    ['short tag', '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$abc'],
    [
      'zero passes',
      '$argon2id$v=19$m=19456,t=0,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    [
      'zero lanes',
      '$argon2id$v=19$m=19456,t=2,p=0$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    [
      'memory too small for the lanes',
      '$argon2id$v=19$m=8,t=2,p=4$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    [
      'a request for 4 TiB',
      '$argon2id$v=19$m=4294967295,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    [
      'a request for 1000 passes',
      '$argon2id$v=19$m=19456,t=1000,p=1$c29tZXNhbHRzb21lc2FsdA$ISO7kkvFzh19GM8qB7patN3C3Y9HHsjlVTfEZ9T600Y',
    ],
    ['not a hash at all', 'password123'],
    ['half a legacy hash', 'deadbeef:'],
  ])('refuses %s without throwing', async (_name, stored) => {
    expect(await hasher.verify(stored, PASSWORD)).toBe(false);
  });

  it('refuses a tag with one character changed', async () => {
    const hash = await hasher.hash(PASSWORD);
    // The tag is 32 bytes, so its last base64 character carries only four significant bits and
    // four different characters there decode to the same bytes. Change the first character,
    // where all six bits count, so this fails the same way on every run.
    const tagStart = hash.lastIndexOf('$') + 1;
    const first = hash[tagStart] === 'A' ? 'B' : 'A';
    expect(
      await hasher.verify(hash.slice(0, tagStart) + first + hash.slice(tagStart + 1), PASSWORD),
    ).toBe(false);
  });
});

describe('hashes from before Argon2id', () => {
  it('still verify, and are marked for replacement', async () => {
    const legacy = await legacyHash(PASSWORD);
    expect(legacy.startsWith('$')).toBe(false);
    expect(await hasher.verify(legacy, PASSWORD)).toBe(true);
    expect(await hasher.verify(legacy, 'wrong')).toBe(false);
    expect(hasher.needsRehash(legacy)).toBe(true);
  });
});

describe('needsRehash', () => {
  it('is false for a hash that is already current', async () => {
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
  });

  it('is true when a setting has been raised since the hash was made', async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(new Argon2idPasswordHasher(settings(32768)).needsRehash(hash)).toBe(true);
    expect(new Argon2idPasswordHasher(settings(19456, 3)).needsRehash(hash)).toBe(true);
    expect(new Argon2idPasswordHasher(settings(19456, 2, 2)).needsRehash(hash)).toBe(true);
  });

  it('is false for a hash that is stronger than the setting: it is never weakened', async () => {
    const strong = await new Argon2idPasswordHasher(settings(32768, 3, 2)).hash(PASSWORD);
    expect(hasher.needsRehash(strong)).toBe(false);
  });

  it('is true for what it cannot read, which has only just verified if it is asked', () => {
    expect(hasher.needsRehash('not a hash')).toBe(true);
  });
});

describe('verifyDummy', () => {
  it('costs about what a real verification costs', async () => {
    const hash = await hasher.hash(PASSWORD);
    await hasher.verifyDummy(PASSWORD); // builds the dummy hash
    const once = async (work: () => Promise<unknown>) => {
      const start = performance.now();
      await work();
      return performance.now() - start;
    };
    // A busy machine slows some runs, and a shared runner can slow one measurement and not the
    // other: an average over three back-to-back runs once saw a real check of 81 ms against a dummy
    // of 30 ms. So take alternating samples and compare the fastest of each, which is the cost of
    // the work itself with the interruptions left out.
    const real: number[] = [];
    const dummy: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      real.push(await once(() => hasher.verify(hash, 'wrong')));
      dummy.push(await once(() => hasher.verifyDummy('wrong')));
    }
    const fastestReal = Math.min(...real);
    const fastestDummy = Math.min(...dummy);
    // The same algorithm at the same settings: well within a factor of two of each other.
    expect(fastestDummy).toBeGreaterThan(fastestReal / 2);
    expect(fastestDummy).toBeLessThan(fastestReal * 2);
  });
});
