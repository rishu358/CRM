import { describe, expect, it } from 'vitest';
import {
  deriveUnsubscribeSecret,
  issueUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe-token.js';
import { isUnsubscribeTokenShape } from './unsubscribe.js';

// Keys made from a repeated letter: obviously not real, and only ever used to sign test tokens.
const CURRENT = deriveUnsubscribeSecret('a'.repeat(48));
const PREVIOUS = deriveUnsubscribeSecret('b'.repeat(48));
const OTHER = deriveUnsubscribeSecret('c'.repeat(48));
const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';
const ANOTHER_ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1e';

describe('signing and checking the unsubscribe token', () => {
  it('issues a token of the right shape that names the email and checks out', () => {
    const token = issueUnsubscribeToken(CURRENT, ID);
    expect(isUnsubscribeTokenShape(token)).toBe(true);
    expect(token.startsWith(`v1.${ID}.`)).toBe(true);
    expect(verifyUnsubscribeToken([CURRENT], token)).toBe(ID);
  });

  it('is the same token every time for one email and one key, so a retry changes nothing', () => {
    expect(issueUnsubscribeToken(CURRENT, ID)).toBe(issueUnsubscribeToken(CURRENT, ID));
    expect(issueUnsubscribeToken(CURRENT, ID)).not.toBe(issueUnsubscribeToken(CURRENT, ANOTHER_ID));
  });

  it('refuses a token signed with a key this process does not hold', () => {
    const token = issueUnsubscribeToken(OTHER, ID);
    expect(verifyUnsubscribeToken([CURRENT, PREVIOUS], token)).toBeNull();
  });

  it('still accepts a token signed with an earlier key after a rotation, because links in old emails must work', () => {
    const old = issueUnsubscribeToken(PREVIOUS, ID);
    expect(verifyUnsubscribeToken([CURRENT], old)).toBeNull();
    expect(verifyUnsubscribeToken([CURRENT, PREVIOUS], old)).toBe(ID);
  });

  it('refuses a signature carried to another email: the id is part of what is signed', () => {
    const signature = issueUnsubscribeToken(CURRENT, ID).split('.')[2];
    expect(verifyUnsubscribeToken([CURRENT], `v1.${ANOTHER_ID}.${signature}`)).toBeNull();
  });

  it('refuses a changed signature, a truncated one and anything that is not a token', () => {
    const token = issueUnsubscribeToken(CURRENT, ID);
    const signature = token.split('.')[2]!;
    // The FIRST character of the signature, never the last: the last of 43 base64url characters carries only 4
    // bits of data, so four different last characters decode to the same bytes (see the door's spec).
    const changedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const flipped = token.replace(signature, changedSignature);
    expect(flipped).not.toBe(token);
    expect(
      Buffer.from(changedSignature, 'base64url').equals(Buffer.from(signature, 'base64url')),
    ).toBe(false);
    expect(verifyUnsubscribeToken([CURRENT], flipped)).toBeNull();
    // Whatever the first character is changed to, never accepted.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const character of alphabet) {
      if (character === signature[0]) continue;
      const other = token.replace(signature, `${character}${signature.slice(1)}`);
      expect(verifyUnsubscribeToken([CURRENT], other), character).toBeNull();
    }
    expect(verifyUnsubscribeToken([CURRENT], token.slice(0, -1))).toBeNull();
    for (const value of [undefined, null, 7, {}, '', 'v1', `v1.${ID}`, 'x'.repeat(5000)]) {
      expect(verifyUnsubscribeToken([CURRENT], value)).toBeNull();
    }
    expect(verifyUnsubscribeToken([], token)).toBeNull();
  });

  it('derives a different key under its own label from the same secret', () => {
    const secret = 'a'.repeat(48);
    expect(deriveUnsubscribeSecret(secret).equals(deriveUnsubscribeSecret(secret))).toBe(true);
    expect(deriveUnsubscribeSecret(secret).length).toBe(32);
    expect(deriveUnsubscribeSecret(secret).equals(Buffer.from(secret))).toBe(false);
  });
});
