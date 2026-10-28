import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  FILL_TOKEN_MAX_AGE_SECONDS,
  FILL_TOKEN_MIN_AGE_SECONDS,
  FORM_KEY_PATTERN,
} from './index.js';

// A subpath of its own (`@crm/core/lead-form-token`), not part of the barrel: this file needs
// `node:crypto`, and the barrel is bundled into the browser.

/**
 * The secrets of the public door: the form key, the fill token and the idempotency digest
 * (ADR-0065 3.1, 4.3).
 *
 * Randomness and the clock are arguments wherever a test needs to pin them, so none of this reads
 * either by itself except `generateFormKey`, which is the one place a key is made.
 */

/** A new form key: 256 bits, so a key cannot be found by guessing. */
export function generateFormKey(bytes: Buffer = randomBytes(32)): string {
  if (bytes.length !== 32) throw new RangeError('A form key is 32 random bytes');
  return `lfk_${bytes.toString('base64url')}`;
}

/** The SHA-256 of a whole key: all the database holds. */
export function hashFormKey(key: string): Buffer {
  if (!FORM_KEY_PATTERN.test(key)) throw new TypeError('Not a form key');
  return createHash('sha256').update(key, 'utf8').digest();
}

/** The last four characters, so a person can tell which key a form is on. */
export function formKeyHint(key: string): string {
  return key.slice(-4);
}

/**
 * The digest an Idempotency-Key is remembered by. Scoped to the form, so the same text on two
 * forms is two requests.
 */
export function hashSubmissionKey(formId: string, key: string): Buffer {
  return createHash('sha256').update(`lead-form-idempotency:v1:${formId}:${key}`, 'utf8').digest();
}

/** The Idempotency-Key a page may send: the same rule as everywhere else (ADR-0060). */
export function isSubmissionKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

/**
 * The key the fill tokens are signed with, derived from the instance's existing auth secret under a
 * fixed label, so the feature adds no secret and no environment variable.
 */
export function deriveFillTokenSecret(authSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', authSecret, Buffer.alloc(0), 'crm:lead-form-fill-token:v1', 32),
  );
}

function sign(secret: Buffer, formId: string, issuedAt: number): string {
  return createHmac('sha256', secret).update(`v1.${issuedAt}.${formId}`).digest('base64url');
}

/**
 * A token saying "this page was drawn for this form at this moment". Stateless: nothing is stored,
 * and it is only worth anything as proof that the page was loaded some seconds ago.
 */
export function issueFillToken(secret: Buffer, formId: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return `v1.${issuedAt}.${sign(secret, formId, issuedAt)}`;
}

export type FillTokenVerdict = 'ok' | 'too_fast' | 'expired' | 'invalid';

export function checkFillToken(
  secret: Buffer,
  formId: string,
  token: unknown,
  now: Date,
): FillTokenVerdict {
  if (typeof token !== 'string' || token.length > 200) return 'invalid';
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (match === null) return 'invalid';

  const issuedAt = Number(match[1]);
  const expected = Buffer.from(sign(secret, formId, issuedAt));
  const given = Buffer.from(match[2] ?? '');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';

  const age = Math.floor(now.getTime() / 1000) - issuedAt;
  if (age < FILL_TOKEN_MIN_AGE_SECONDS) return 'too_fast';
  if (age > FILL_TOKEN_MAX_AGE_SECONDS) return 'expired';
  return 'ok';
}
