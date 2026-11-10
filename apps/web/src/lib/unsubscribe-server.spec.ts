import { describe, expect, it } from 'vitest';
import { fetchUnsubscribePage, submitUnsubscribe } from './unsubscribe-server';

const TOKEN = `v1.0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d.${'A'.repeat(43)}`;
const API = 'https://api.example.test';

interface Seen {
  url: string;
  init: RequestInit;
}

function fake(respond: () => Response | Error) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init: init ?? {} });
    const result = respond();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { fetchFn, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('asking whose email an unsubscribe link belongs to', () => {
  it('reads the company name from the API, on a path built from the token, with no credential', async () => {
    const { fetchFn, seen } = fake(() => json(200, { data: { companyName: 'Sharma Traders' } }));
    const result = await fetchUnsubscribePage({
      apiUrl: API,
      token: TOKEN,
      clientAddress: { 'x-forwarded-for': '203.0.113.9' },
      fetchFn,
    });
    expect(result).toEqual({ kind: 'ask', companyName: 'Sharma Traders' });
    expect(seen[0]?.url).toBe(`${API}/api/v1/public/email-unsubscribe/${TOKEN}`);
    expect(seen[0]?.init.method).toBe('GET');
    expect(seen[0]?.init.cache).toBe('no-store');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['x-forwarded-for']);
  });

  it('is "invalid" for a 404, an odd answer, no name and an API that is down, all alike', async () => {
    for (const respond of [
      () => json(404, { error: { code: 'NOT_FOUND' } }),
      () => json(200, { data: {} }),
      () => json(200, { data: { companyName: '' } }),
      () => json(200, {}),
      () => new Response('not json', { status: 200 }),
      () => new Error('connection refused'),
    ]) {
      const { fetchFn } = fake(respond);
      expect(await fetchUnsubscribePage({ apiUrl: API, token: TOKEN, fetchFn })).toEqual({
        kind: 'invalid',
      });
    }
  });

  it('never calls the API for something that cannot be a token', async () => {
    const { fetchFn, seen } = fake(() => json(200, { data: { companyName: 'x' } }));
    for (const token of ['', 'hello', '../../health', `${TOKEN}/../x`, `${TOKEN}\n`, 'v1.a.b']) {
      expect(await fetchUnsubscribePage({ apiUrl: API, token, fetchFn })).toEqual({
        kind: 'invalid',
      });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('doing it', () => {
  it('posts the one fixed phrase a mail program posts, and says done for a 204', async () => {
    const { fetchFn, seen } = fake(() => new Response(null, { status: 204 }));
    expect(await submitUnsubscribe({ apiUrl: API, token: TOKEN, fetchFn })).toBe('done');
    expect(seen[0]?.url).toBe(`${API}/api/v1/public/email-unsubscribe/${TOKEN}`);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.body).toBe('List-Unsubscribe=One-Click');
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('is "invalid" for a 404 and "busy" for a limit, a failure or an API that is down', async () => {
    const cases: [() => Response | Error, string][] = [
      [() => new Response(null, { status: 404 }), 'invalid'],
      [() => new Response(null, { status: 429 }), 'busy'],
      [() => new Response(null, { status: 500 }), 'busy'],
      [() => new Error('timeout'), 'busy'],
    ];
    for (const [respond, expected] of cases) {
      const { fetchFn } = fake(respond);
      expect(await submitUnsubscribe({ apiUrl: API, token: TOKEN, fetchFn })).toBe(expected);
    }
  });

  it('does not call the API for something that cannot be a token', async () => {
    const { fetchFn, seen } = fake(() => new Response(null, { status: 204 }));
    expect(await submitUnsubscribe({ apiUrl: API, token: 'nope', fetchFn })).toBe('invalid');
    expect(seen).toHaveLength(0);
  });
});
