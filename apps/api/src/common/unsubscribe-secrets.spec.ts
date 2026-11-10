import { deriveReplySecret as deriveReplyKey } from '@crm/core/email-reply-address';
import {
  deriveUnsubscribeSecret,
  issueUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@crm/core/email-unsubscribe-token';
import { describe, expect, it } from 'vitest';
import { issueReplyToken, verifyReplyToken } from '@crm/core/email-reply-address';
import {
  replySigningSecret,
  replyVerifySecrets,
  unsubscribeSigningSecret,
  unsubscribeVerifySecrets,
} from './unsubscribe-secrets.js';

// Keys made from a repeated letter: obviously not real, and only ever used to sign test tokens.
const AUTH = 'a'.repeat(48);
const AUTH_OLD = 'b'.repeat(48);
const OWN = 'o'.repeat(48);
const OWN_OLD = 'p'.repeat(48);
const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';

const withOwn = {
  AUTH_SECRET: AUTH,
  AUTH_SECRET_PREVIOUS: AUTH_OLD,
  EMAIL_UNSUBSCRIBE_SECRET: OWN,
  EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS: OWN_OLD,
};
const fallback = { AUTH_SECRET: AUTH, AUTH_SECRET_PREVIOUS: AUTH_OLD };

const tokenSignedWith = (key: string) => issueUnsubscribeToken(deriveUnsubscribeSecret(key), ID);

describe('with an own unsubscribe secret', () => {
  it('signs with it, and with nothing derived from AUTH_SECRET', () => {
    const token = issueUnsubscribeToken(unsubscribeSigningSecret(withOwn), ID);
    expect(token).toBe(tokenSignedWith(OWN));
    expect(token).not.toBe(tokenSignedWith(AUTH));
  });

  it('accepts its own links and those of its earlier keys, so a rotation keeps old links working', () => {
    const keys = unsubscribeVerifySecrets(withOwn);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(OWN))).toBe(ID);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(OWN_OLD))).toBe(ID);
  });

  it('refuses a link signed under AUTH_SECRET or its earlier keys: the session secret is no longer the key', () => {
    const keys = unsubscribeVerifySecrets(withOwn);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(AUTH))).toBeNull();
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(AUTH_OLD))).toBeNull();
  });

  it('is not moved by rotating AUTH_SECRET: the same links check out before and after', () => {
    const before = unsubscribeVerifySecrets(withOwn);
    const rotated = unsubscribeVerifySecrets({
      ...withOwn,
      AUTH_SECRET: 'z'.repeat(48),
      AUTH_SECRET_PREVIOUS: AUTH,
    });
    const link = tokenSignedWith(OWN);
    expect(verifyUnsubscribeToken(before, link)).toBe(ID);
    expect(verifyUnsubscribeToken(rotated, link)).toBe(ID);
  });

  it('treats an empty value as unset', () => {
    const empty = { ...fallback, EMAIL_UNSUBSCRIBE_SECRET: '' };
    expect(issueUnsubscribeToken(unsubscribeSigningSecret(empty), ID)).toBe(tokenSignedWith(AUTH));
  });
});

describe('with no own secret (development, tests, CI: production refuses to start like this)', () => {
  it('falls back to a key derived from AUTH_SECRET, and checks against its earlier keys too', () => {
    expect(issueUnsubscribeToken(unsubscribeSigningSecret(fallback), ID)).toBe(
      tokenSignedWith(AUTH),
    );
    const keys = unsubscribeVerifySecrets(fallback);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(AUTH))).toBe(ID);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(AUTH_OLD))).toBe(ID);
    expect(verifyUnsubscribeToken(keys, tokenSignedWith(OWN))).toBeNull();
  });
});

describe('the keys of the reply address (ADR-0077)', () => {
  const replyFor = (secret: string) => issueReplyToken(deriveReplyKey(secret), ID);

  it('use the same secrets as the unsubscribe link, each under its own label', () => {
    const token = issueReplyToken(replySigningSecret(withOwn), ID);
    expect(verifyReplyToken(replyVerifySecrets(withOwn), token)).toBe(ID);
    expect(replySigningSecret(withOwn).equals(unsubscribeSigningSecret(withOwn))).toBe(false);
  });

  it('accept an address signed under an earlier own key, and refuse one signed under AUTH_SECRET', () => {
    const keys = replyVerifySecrets(withOwn);
    expect(verifyReplyToken(keys, replyFor(OWN))).toBe(ID);
    expect(verifyReplyToken(keys, replyFor(OWN_OLD))).toBe(ID);
    expect(verifyReplyToken(keys, replyFor(AUTH))).toBeNull();
    expect(verifyReplyToken(keys, replyFor(AUTH_OLD))).toBeNull();
  });

  it('are not moved by rotating AUTH_SECRET', () => {
    const address = replyFor(OWN);
    const rotated = replyVerifySecrets({
      ...withOwn,
      AUTH_SECRET: 'z'.repeat(48),
      AUTH_SECRET_PREVIOUS: AUTH,
    });
    expect(verifyReplyToken(rotated, address)).toBe(ID);
  });

  it('fall back to AUTH_SECRET in development, as the unsubscribe link does', () => {
    expect(issueReplyToken(replySigningSecret(fallback), ID)).toBe(replyFor(AUTH));
    const keys = replyVerifySecrets(fallback);
    expect(verifyReplyToken(keys, replyFor(AUTH))).toBe(ID);
    expect(verifyReplyToken(keys, replyFor(AUTH_OLD))).toBe(ID);
    expect(verifyReplyToken(keys, replyFor(OWN))).toBeNull();
  });

  it('do not accept a link made for the unsubscribe side: one signature is worth nothing to the other', () => {
    const unsubscribeKey = unsubscribeSigningSecret(withOwn);
    expect(verifyReplyToken([unsubscribeKey], issueReplyToken(unsubscribeKey, ID))).toBe(ID);
    // The same bytes as a key are only a match when the label is the same, which it is not.
    expect(
      verifyReplyToken(replyVerifySecrets(withOwn), issueReplyToken(unsubscribeKey, ID)),
    ).toBeNull();
  });
});
