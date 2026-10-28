import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { authenticatorCode } from '../testing/totp-reference.js';
import {
  dataOf,
  request,
  startApiHarness,
  tokenFromEmail,
  type ApiHarness,
} from '../testing/harness.js';

/**
 * What a wrong password costs, and what a right one does not (CLAUDE.md §5.9, §5.14, ADR-0064).
 *
 * Finding F8 of the pilot: fifty sign-ins from one address in a quarter of an hour locked everyone at
 * that address out, successful ones included. These tests pin the three budgets apart: the flood
 * ceiling counts every request, the failure budgets count only wrong answers, and a right answer gives
 * its slot back.
 */
const PASSWORD = 'correct-horse-battery-staple';
const WRONG = 'wrong-horse-battery-staple';
const WINDOW_SECONDS = 900;
const ACCOUNT_FAILURES = 4;
const ADDRESS_FAILURES = 6;

let harness: ApiHarness;
let nextHost = 1;

/** `count` copies of a status, for comparing a run of answers. */
const times = (status: number, count: number): number[] =>
  Array.from({ length: count }, () => status);

/** A new address for every call that should not share a budget with another. */
const freshAddress = () => `198.51.100.${String(nextHost++)}`;

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

const signIn = (email: string, password: string, remoteAddress: string, headers = {}) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { email, password },
    remoteAddress,
    headers,
  });

/** An account with a verified address, made from addresses of its own so it spends nobody's budget. */
async function account(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const address = freshAddress();
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Test Person' },
    remoteAddress: address,
  });
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
    remoteAddress: address,
  });
  return email;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'), {
    AUTH_RATE_LIMIT_MAX_PER_IP: '200',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: String(WINDOW_SECONDS),
    AUTH_FAILURE_MAX_PER_ACCOUNT: String(ACCOUNT_FAILURES),
    AUTH_FAILURE_MAX_PER_IP: String(ADDRESS_FAILURES),
  });
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('successful sign-ins do not use up the failure budgets', () => {
  it('lets many people sign in from one address, more than the address may fail', async () => {
    const office = freshAddress();
    const emails: string[] = [];
    for (let i = 0; i < ADDRESS_FAILURES + 4; i += 1) emails.push(await account('office'));

    const statuses: number[] = [];
    for (const email of emails) statuses.push((await signIn(email, PASSWORD, office)).status);

    expect(statuses).toEqual(times(200, emails.length));
  }, 120_000);

  it('lets one person sign in again and again, more often than an account may fail', async () => {
    const email = await account('frequent');
    const statuses: number[] = [];
    for (let i = 0; i < ACCOUNT_FAILURES * 3; i += 1) {
      statuses.push((await signIn(email, PASSWORD, freshAddress())).status);
    }
    expect(statuses).toEqual(times(200, ACCOUNT_FAILURES * 3));
  }, 120_000);

  it('does not let colleagues who mistype once each lock the office out of signing in', async () => {
    const office = freshAddress();
    const emails: string[] = [];
    for (let i = 0; i < 4; i += 1) emails.push(await account('typo'));

    // Each person gets it wrong once and right the second time: four failures, under the six an
    // address may have, and every one of the four then signs in.
    for (const email of emails) expect((await signIn(email, WRONG, office)).status).toBe(401);
    for (const email of emails) expect((await signIn(email, PASSWORD, office)).status).toBe(200);
  }, 120_000);
});

describe('failed sign-ins from one address are limited', () => {
  it('refuses the address once it has failed too often, and only that address', async () => {
    const attacker = freshAddress();
    const statuses: number[] = [];
    // A different account each time, so the account budget is not the one being spent.
    for (let i = 0; i < ADDRESS_FAILURES + 2; i += 1) {
      statuses.push((await signIn(uniqueEmail('spray'), WRONG, attacker)).status);
    }
    expect(statuses).toEqual([...times(401, ADDRESS_FAILURES), 429, 429]);

    // Even a right password from that address waits: the budget is the address's, not the attempt's.
    const someone = await account('bystander');
    expect((await signIn(someone, PASSWORD, attacker)).status).toBe(429);
    // Another address is untouched.
    expect((await signIn(someone, PASSWORD, freshAddress())).status).toBe(200);
  }, 120_000);

  it('says how long to wait, honestly', async () => {
    const attacker = freshAddress();
    for (let i = 0; i < ADDRESS_FAILURES; i += 1) {
      await signIn(uniqueEmail('wait'), WRONG, attacker);
    }
    const refused = await signIn(uniqueEmail('wait'), WRONG, attacker);
    expect(refused.status).toBe(429);

    const wait = Number(refused.headers['retry-after']);
    expect(Number.isInteger(wait)).toBe(true);
    // The window began with the first failure a moment ago: nearly all of it is left, and never more.
    expect(wait).toBeGreaterThan(WINDOW_SECONDS - 60);
    expect(wait).toBeLessThanOrEqual(WINDOW_SECONDS);
  }, 120_000);
});

describe('failed sign-ins on one account are limited, wherever they come from', () => {
  it('refuses the account after too many failures from different addresses, a right password included', async () => {
    const email = await account('target');
    const statuses: number[] = [];
    for (let i = 0; i < ACCOUNT_FAILURES + 1; i += 1) {
      statuses.push((await signIn(email, WRONG, freshAddress())).status);
    }
    expect(statuses).toEqual([...times(401, ACCOUNT_FAILURES), 429]);

    // From an address that has never failed, with the right password: still refused, because
    // answering it would tell a guesser which attempt was right.
    expect((await signIn(email, PASSWORD, freshAddress())).status).toBe(429);

    // A different account from the same kind of address is not affected.
    const other = await account('untouched');
    expect((await signIn(other, PASSWORD, freshAddress())).status).toBe(200);
  }, 120_000);

  it('is not raised by changing the forwarded address on each try', async () => {
    const email = await account('rotating');
    const webServer = '10.0.0.5';
    const statuses: number[] = [];
    for (let i = 0; i < ACCOUNT_FAILURES + 3; i += 1) {
      statuses.push(
        (await signIn(email, WRONG, webServer, { 'x-forwarded-for': freshAddress() })).status,
      );
    }
    expect(statuses).toEqual([...times(401, ACCOUNT_FAILURES), 429, 429, 429]);
  }, 120_000);

  it('does not depend on the case or spacing of the address typed', async () => {
    const email = await account('casing');
    for (let i = 0; i < ACCOUNT_FAILURES; i += 1) {
      await signIn(i % 2 === 0 ? email.toUpperCase() : email, WRONG, freshAddress());
    }
    expect((await signIn(email, WRONG, freshAddress())).status).toBe(429);
  }, 120_000);

  it('waits longer than the window has left for neither: the wait is what is left', async () => {
    const email = await account('left');
    for (let i = 0; i < ACCOUNT_FAILURES; i += 1) await signIn(email, WRONG, freshAddress());
    const refused = await signIn(email, WRONG, freshAddress());
    const wait = Number(refused.headers['retry-after']);
    expect(wait).toBeGreaterThan(WINDOW_SECONDS - 60);
    expect(wait).toBeLessThanOrEqual(WINDOW_SECONDS);
  }, 120_000);
});

describe('nothing says whether an account exists', () => {
  it('refuses a name with no account after the same tries, with the same answer, as one with an account', async () => {
    const known = await account('known');
    const unknown = uniqueEmail('unknown');

    const run = async (email: string) => {
      const out: { status: number; body: unknown }[] = [];
      for (let i = 0; i < ACCOUNT_FAILURES + 1; i += 1) {
        const response = await signIn(email, WRONG, freshAddress());
        out.push({ status: response.status, body: withoutRequestId(response.body) });
      }
      return out;
    };

    const asKnown = await run(known);
    const asUnknown = await run(unknown);

    expect(asUnknown.map((entry) => entry.status)).toEqual(asKnown.map((entry) => entry.status));
    expect(asUnknown).toEqual(asKnown);
    expect(asKnown[ACCOUNT_FAILURES]?.status).toBe(429);
  }, 120_000);

  it('answers the refusal with the generic message, not the budget that was spent', async () => {
    const attacker = freshAddress();
    for (let i = 0; i < ADDRESS_FAILURES; i += 1) {
      await signIn(uniqueEmail('msg'), WRONG, attacker);
    }
    const refused = await signIn(uniqueEmail('msg'), WRONG, attacker);
    const text = JSON.stringify(refused.body);
    expect(text).toContain('Too many attempts');
    expect(text).not.toMatch(/account|address|budget|\b\d+ (attempts|failures)\b/i);
  }, 120_000);
});

describe('the second step of a sign-in is limited the same way', () => {
  it('counts a wrong code as a failed attempt on the account', async () => {
    // An account with a second factor: sign in, enrol, confirm, then sign in again for a challenge.
    const email = await account('mfa');
    const first = await signIn(email, PASSWORD, freshAddress());
    const token = dataOf<{ token: string }>(first).token;
    const enrolment = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      token,
    });
    const secret = dataOf<{ secret: string }>(enrolment).secret;
    const activated = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/mfa/activate',
      token,
      body: { code: authenticatorCode(secret) },
    });
    expect(activated.status).toBeLessThan(300);

    const wrongCodes: number[] = [];
    for (let i = 0; i < ACCOUNT_FAILURES + 1; i += 1) {
      const challenge = await signIn(email, PASSWORD, freshAddress());
      if (challenge.status === 429) {
        wrongCodes.push(429);
        continue;
      }
      const challengeToken = dataOf<{ challengeToken?: string }>(challenge).challengeToken;
      if (challengeToken === undefined) {
        wrongCodes.push(challenge.status);
        continue;
      }
      const verified = await request(harness, {
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        body: { challengeToken, code: '000000' },
        remoteAddress: freshAddress(),
      });
      wrongCodes.push(verified.status);
    }
    expect(wrongCodes.at(-1)).toBe(429);
  }, 120_000);
});

function withoutRequestId(body: Record<string, unknown>): unknown {
  const error = body['error'];
  if (typeof error !== 'object' || error === null) return body;
  const { requestId: _requestId, ...rest } = error as Record<string, unknown>;
  return { ...body, error: rest };
}
