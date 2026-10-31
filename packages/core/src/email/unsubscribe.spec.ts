import { describe, expect, it } from 'vitest';
import {
  isUnsubscribeTokenShape,
  unsubscribeEmailIdOf,
  unsubscribeOneClickUrl,
  unsubscribePageUrl,
} from './unsubscribe.js';

const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';
const SIGNATURE = 'A'.repeat(43);
const TOKEN = `v1.${ID}.${SIGNATURE}`;

describe('the shape of a token', () => {
  it('accepts exactly version, an email id and a 256-bit signature', () => {
    expect(isUnsubscribeTokenShape(TOKEN)).toBe(true);
    expect(unsubscribeEmailIdOf(TOKEN)).toBe(ID);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['another version', `v2.${ID}.${SIGNATURE}`],
    ['an id that is not a uuid', `v1.not-a-uuid.${SIGNATURE}`],
    ['an upper-case id', `v1.${ID.toUpperCase()}.${SIGNATURE}`],
    ['a short signature', `v1.${ID}.${'A'.repeat(42)}`],
    ['a long signature', `v1.${ID}.${'A'.repeat(44)}`],
    ['a signature with a padding character', `v1.${ID}.${'A'.repeat(42)}=`],
    ['a trailing newline', `${TOKEN}\n`],
    ['a path separator', `v1.${ID}.${'A'.repeat(40)}/..`],
    ['a leading space', ` ${TOKEN}`],
  ])('refuses %s', (_name, value) => {
    expect(isUnsubscribeTokenShape(value)).toBe(false);
    if (typeof value === 'string') expect(unsubscribeEmailIdOf(value)).toBeNull();
  });
});

describe('the addresses built from a token', () => {
  it('puts the page on the web origin and the one-click post on the API origin', () => {
    expect(unsubscribePageUrl('https://app.example.com', TOKEN)).toBe(
      `https://app.example.com/u/${TOKEN}`,
    );
    expect(unsubscribeOneClickUrl('https://api.example.com', TOKEN)).toBe(
      `https://api.example.com/api/v1/public/email-unsubscribe/${TOKEN}`,
    );
  });

  it('does not double a trailing slash on the origin', () => {
    expect(unsubscribePageUrl('https://app.example.com/', TOKEN)).toBe(
      `https://app.example.com/u/${TOKEN}`,
    );
  });
});
