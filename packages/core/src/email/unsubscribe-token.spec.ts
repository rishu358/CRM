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
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyUnsubscribeToken([CURRENT], flipped)).toBeNull();
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
