import { describe, expect, it, vi } from 'vitest';
import { fetchPublicForm, keyFromFormPath } from './public-form-server';

const KEY = `lfk_${'A'.repeat(43)}`;
const DEFINITION = {
  name: 'Contact us',
  fields: [],
  consentText: 'I agree that this company may contact me.',
  privacyUrl: null,
  successMessage: 'Thanks',
  successRedirectUrl: null,
  allowedOrigins: ['https://shop.example.com'],
  fillToken: 'v1.1.x',
};

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('fetchPublicForm', () => {
  it('reads the definition from the API, with no credential and only the visitor address', async () => {
    const fetchFn = answering(200, { data: DEFINITION });
    const result = await fetchPublicForm({
      apiUrl: 'http://api.example',
      key: KEY,
      clientAddress: { 'x-forwarded-for': '203.0.113.9' },
      fetchFn,
    });
    expect(result).toEqual({ kind: 'form', form: DEFINITION });

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(url.toString()).toBe(`http://api.example/api/v1/public/forms/${KEY}`);
    expect(init.headers).toEqual({ 'x-forwarded-for': '203.0.113.9' });
    expect(init.cache).toBe('no-store');
  });

  it.each([
    ['a key of the wrong shape', 'lfk_short', 200],
    ['a path trick', '../auth/me', 200],
    ['a 404', KEY, 404],
    ['a 429', KEY, 429],
    ['a 500', KEY, 500],
  ])('says unavailable for %s', async (_label, key, status) => {
    const fetchFn = answering(status, { data: DEFINITION });
    const result = await fetchPublicForm({ apiUrl: 'http://api.example', key, fetchFn });
    expect(result).toEqual({ kind: 'unavailable' });
    // A key of the wrong shape never reaches the API at all.
    if (!/^lfk_[A-Za-z0-9_-]{43}$/.test(key)) expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says unavailable when the API cannot be reached or answers nonsense', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
    expect(
      await fetchPublicForm({ apiUrl: 'http://api.example', key: KEY, fetchFn: failing }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await fetchPublicForm({
        apiUrl: 'http://api.example',
        key: KEY,
        fetchFn: answering(200, {}),
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('keyFromFormPath', () => {
  it('takes the one segment after /f/', () => {
    expect(keyFromFormPath(`/f/${KEY}`)).toBe(KEY);
    expect(keyFromFormPath(`/f/${KEY}/`)).toBe(KEY);
  });

  it.each(['/f', '/f/', '/f/a/b', '/forms/x', '/dashboard'])('is null for %s', (path) => {
    expect(keyFromFormPath(path)).toBeNull();
  });
});
