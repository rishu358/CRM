import { describe, expect, it } from 'vitest';
import { deriveReplySecret, issueReplyToken, verifyReplyToken } from './reply-address-token.js';
import { deriveUnsubscribeSecret } from './unsubscribe-token.js';
import { REPLY_LOCAL_PATTERN, emailIdFromReplyLocal } from './reply.js';

// Keys made from a repeated letter: obviously not real, and only ever used to sign test tokens.
const CURRENT = deriveReplySecret('a'.repeat(48));
const PREVIOUS = deriveReplySecret('b'.repeat(48));
const OTHER = deriveReplySecret('c'.repeat(48));
const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';
const ANOTHER_ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1e';

describe('signing and checking the reply address', () => {
  it('issues a local part of the right shape that names the email and checks out', () => {
    const local = issueReplyToken(CURRENT, ID);
    expect(local).toMatch(REPLY_LOCAL_PATTERN);
    expect(local).toHaveLength(61);
    expect(emailIdFromReplyLocal(local)).toBe(ID);
    expect(verifyReplyToken([CURRENT], local)).toBe(ID);
  });

  it('is the same every time for one email and one key, and different for another email', () => {
    expect(issueReplyToken(CURRENT, ID)).toBe(issueReplyToken(CURRENT, ID));
    expect(issueReplyToken(CURRENT, ID)).not.toBe(issueReplyToken(CURRENT, ANOTHER_ID));
  });

  it('refuses one signed with a key this process does not hold', () => {
    expect(verifyReplyToken([CURRENT, PREVIOUS], issueReplyToken(OTHER, ID))).toBeNull();
  });

  it('still accepts one signed with an earlier key, because an address in an old email must keep working', () => {
    const old = issueReplyToken(PREVIOUS, ID);
    expect(verifyReplyToken([CURRENT], old)).toBeNull();
    expect(verifyReplyToken([CURRENT, PREVIOUS], old)).toBe(ID);
  });

  it('refuses a signature carried to another email: the id is part of what is signed', () => {
    const signature = issueReplyToken(CURRENT, ID).split('.')[2]!;
    expect(
      verifyReplyToken([CURRENT], `r.${ANOTHER_ID.replaceAll('-', '')}.${signature}`),
    ).toBeNull();
  });

  it('refuses a change to ANY character of the signature, the last included: only the exact string is accepted', () => {
    // 26 base32 characters carry 130 bits for 128 of data, so the last one has two spare bits. Comparing decoded
    // bytes would let a different last character through; comparing the strings does not.
    const local = issueReplyToken(CURRENT, ID);
    const start = local.lastIndexOf('.') + 1;
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    for (let position = start; position < local.length; position += 1) {
      for (const character of alphabet) {
        if (character === local[position]) continue;
        const changed = `${local.slice(0, position)}${character}${local.slice(position + 1)}`;
        expect(verifyReplyToken([CURRENT], changed), `${String(position)} ${character}`).toBeNull();
      }
    }
  });

  it('refuses upper case, a truncated value and anything that is not a local part', () => {
    const local = issueReplyToken(CURRENT, ID);
    expect(verifyReplyToken([CURRENT], local.toUpperCase())).toBeNull();
    expect(verifyReplyToken([CURRENT], local.slice(0, -1))).toBeNull();
    for (const value of [undefined, null, 7, {}, '', 'r', `${local}x`, 'x'.repeat(5000)]) {
      expect(verifyReplyToken([CURRENT], value)).toBeNull();
    }
    expect(verifyReplyToken([], local)).toBeNull();
  });

  it('refuses to make an address for something that is not an email id', () => {
    for (const value of ['', 'not-an-id', ID.toUpperCase(), `${ID}x`]) {
      expect(() => issueReplyToken(CURRENT, value)).toThrow(TypeError);
    }
  });

  it('derives a key of its own from a secret, different from the unsubscribe link’s', () => {
    const secret = 'a'.repeat(48);
    expect(deriveReplySecret(secret).equals(deriveReplySecret(secret))).toBe(true);
    expect(deriveReplySecret(secret).length).toBe(32);
    expect(deriveReplySecret(secret).equals(deriveUnsubscribeSecret(secret))).toBe(false);
  });
});
