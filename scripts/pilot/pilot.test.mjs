import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUSINESSES, staffEmail } from './data/businesses.mjs';
import { parseCsv, toCsv } from './lib/csv.mjs';
import { gstinCheckCharacter, makeGenerator } from './lib/gen.mjs';
import { makeRng } from './lib/prng.mjs';
import { percentile } from './lib/stats.mjs';
import { totp } from './lib/totp.mjs';

/** Tests for the pilot simulation's own tooling (not for the product). */

test('the same seed gives the same numbers, a different seed does not', () => {
  const a = makeRng('x');
  const b = makeRng('x');
  const c = makeRng('y');
  const first = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(
    first,
    Array.from({ length: 5 }, () => b.next()),
  );
  assert.notDeepEqual(
    first,
    Array.from({ length: 5 }, () => c.next()),
  );
});

test('generated data is reproducible', () => {
  const make = () => {
    const gen = makeGenerator(makeRng('wholesale/test'));
    return Array.from({ length: 20 }, () => [
      gen.companyName(['Traders']),
      gen.phone(),
      gen.gstin('27'),
    ]);
  };
  assert.deepEqual(make(), make());
});

test('phone numbers pass the API shape but cannot belong to a subscriber', () => {
  const gen = makeGenerator(makeRng('phones'));
  for (let index = 0; index < 500; index += 1) {
    const phone = gen.phone();
    assert.match(phone, /^\+[1-9]\d{1,14}$/);
    assert.match(phone, /^\+910\d{9}$/);
  }
});

test('GSTINs have the right shape and a check character that is wrong on purpose', () => {
  const gen = makeGenerator(makeRng('gstins'));
  for (let index = 0; index < 500; index += 1) {
    const gstin = gen.gstin('27');
    assert.match(gstin, /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/);
    assert.notEqual(gstin[14], gstinCheckCharacter(gstin.slice(0, 14)));
  }
});

test('the check character rule is self-consistent (a correct one makes the weighted sum divisible by 36)', () => {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const weightedSum = (text) =>
    [...text].reduce((sum, character, index) => {
      const product = alphabet.indexOf(character) * (index % 2 === 0 ? 1 : 2);
      return sum + Math.floor(product / 36) + (product % 36);
    }, 0);
  const gen = makeGenerator(makeRng('checksum'));
  for (let index = 0; index < 50; index += 1) {
    const wrong = gen.gstin('29');
    const first14 = wrong.slice(0, 14);
    assert.equal(weightedSum(first14 + gstinCheckCharacter(first14)) % 36, 0);
    assert.notEqual(weightedSum(wrong) % 36, 0);
  }
});

test('emails are only ever at .example addresses', () => {
  const gen = makeGenerator(makeRng('emails'));
  for (let index = 0; index < 100; index += 1) {
    assert.match(
      gen.email('Some Person', gen.domainFor(gen.companyName(['Stores']))),
      /\.example$/,
    );
  }
  for (const business of BUSINESSES) {
    assert.match(business.domain, /\.example$/);
    assert.match(business.tenantName, /Pilot/);
    for (const member of business.staff)
      assert.match(staffEmail(business, member), /@[a-z0-9-]+\.example$/);
  }
});

test('one-time codes match the RFC 6238 test vectors', () => {
  // The RFC's secret is the ASCII text 12345678901234567890; the code takes it in base32, so encode it here
  // rather than keeping a base32 literal (which a secret scanner rightly dislikes). The RFC lists 8-digit
  // codes; the last six digits are ours.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from('12345678901234567890')) bits += byte.toString(2).padStart(8, '0');
  const secret = (bits.match(/.{1,5}/g) ?? [])
    .map((chunk) => alphabet[parseInt(chunk.padEnd(5, '0'), 2)])
    .join('');
  assert.equal(totp(secret, 59 * 1000), '287082');
  assert.equal(totp(secret, 1111111109 * 1000), '081804');
  assert.equal(totp(secret, 1234567890 * 1000), '005924');
});

test('CSV reading and writing round-trip quoting and formulas', () => {
  const rows = [
    ['a', 'b,c', 'd"e'],
    ['=HYPERLINK("x")', 'line\nbreak', ''],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('percentiles pick the right value', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile([], 0.5), null);
});
