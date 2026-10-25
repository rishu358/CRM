import { describe, expect, it, vi } from 'vitest';
import {
  checkSession,
  gateStep,
  isDocumentLoad,
  isFilePath,
  isPublicPath,
  isSessionEnded,
  safeReturnTo,
  signInQuery,
} from './session-gate';

describe('isPublicPath', () => {
  it.each(['/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/verify-email'])(
    '%s works without a session',
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    },
  );

  it('lets an invitation link through, with or without more path', () => {
    expect(isPublicPath('/accept-invite')).toBe(true);
    expect(isPublicPath('/accept-invite/anything')).toBe(true);
  });

  it.each([
    '/',
    '/dashboard',
    '/contacts',
    '/settings/security',
    '/sign-inx',
    '/sign-in-evil',
    '/x/sign-in',
    '/Sign-In',
  ])('%s needs a session', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe('isFilePath', () => {
  it('recognises a configured logo and leaves pages alone', () => {
    expect(isFilePath('/brand/logo.svg')).toBe(true);
    expect(isFilePath('/robots.txt')).toBe(true);
    expect(isFilePath('/contacts')).toBe(false);
    expect(isFilePath('/settings/audit-log')).toBe(false);
    expect(isFilePath('/a.b/c')).toBe(false);
  });
});

describe('isSessionEnded', () => {
  it('is the session code on a 401 and nothing else', () => {
    expect(isSessionEnded(401, 'UNAUTHENTICATED')).toBe(true);
  });

  it('leaves a wrong password on the form: it is a 401 as well', () => {
    expect(isSessionEnded(401, 'INVALID_CREDENTIALS')).toBe(false);
    expect(isSessionEnded(401, 'MFA_INVALID')).toBe(false);
    expect(isSessionEnded(401, undefined)).toBe(false);
  });

  it('does not treat a refusal or a failure as a dead session', () => {
    expect(isSessionEnded(403, 'FORBIDDEN')).toBe(false);
    expect(isSessionEnded(403, 'UNAUTHENTICATED')).toBe(false);
    expect(isSessionEnded(500, 'INTERNAL')).toBe(false);
  });
});

describe('safeReturnTo', () => {
  it('keeps a path on this site', () => {
    expect(safeReturnTo('/contacts')).toBe('/contacts');
    expect(safeReturnTo('/contacts/0198f0f0-0000-7000-8000-000000000000')).toBe(
      '/contacts/0198f0f0-0000-7000-8000-000000000000',
    );
    expect(safeReturnTo('/settings/security')).toBe('/settings/security');
  });

  it('drops the query and the fragment', () => {
    expect(safeReturnTo('/contacts?q=Asha+Rao#top')).toBe('/contacts');
  });

  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a full address', 'https://evil.example/x'],
    ['a protocol-relative address', '//evil.example'],
    ['a protocol-relative address with a path', '//evil.example/contacts'],
    ['a backslash host', '/\\evil.example'],
    ['a backslash later on', '/contacts\\..\\evil'],
    ['a script', 'javascript:alert(1)'],
    ['no leading slash', 'contacts'],
    ['a dot segment that becomes //host', '/.//evil.example'],
    ['parent segments that become //host', '/..//evil.example'],
    ['a newline', '/contacts\n/evil'],
    ['a tab', '/\tcontacts'],
    ['a NUL', '/contacts\u0000'],
    ['a sign-in loop', '/sign-in'],
    ['a sign-in page deeper down', '/sign-in/x'],
    ['an API path', '/api/proxy/contacts'],
    ['the API root', '/api'],
    ['an over-long value', `/${'a'.repeat(600)}`],
  ])('refuses %s', (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it('never returns anything that could leave this site, whatever the input', () => {
    const pieces = ['/', '\\', '.', '..', '%2f', '%5c', 'a', ':', '@', '?', '#', ' ', '\t'];
    for (const first of pieces) {
      for (const second of pieces) {
        for (const third of pieces) {
          const result = safeReturnTo(`/${first}${second}${third}evil.example`);
          if (result !== null) {
            expect(result.startsWith('/')).toBe(true);
            expect(result.startsWith('//')).toBe(false);
            expect(result.includes('\\')).toBe(false);
          }
        }
      }
    }
  });
});

describe('signInQuery', () => {
  it('says why, and where the person was', () => {
    expect(signInQuery('/contacts', { sessionEnded: true })).toBe(
      '?reason=session-ended&returnTo=%2Fcontacts',
    );
  });

  it('says nothing about an ended session when there was none', () => {
    expect(signInQuery('/contacts', { sessionEnded: false })).toBe('?returnTo=%2Fcontacts');
  });

  it('has nothing to add for the front door', () => {
    expect(signInQuery('/', { sessionEnded: false })).toBe('');
    expect(signInQuery('/', { sessionEnded: true })).toBe('?reason=session-ended');
  });

  it('does not carry a path it would not accept back', () => {
    expect(signInQuery('/sign-in', { sessionEnded: true })).toBe('?reason=session-ended');
    expect(signInQuery('//evil.example', { sessionEnded: false })).toBe('');
  });
});

describe('gateStep', () => {
  it('lets the signed-out screens and files through', () => {
    expect(gateStep('/sign-in', false)).toBe('open');
    expect(gateStep('/sign-in', true)).toBe('open');
    expect(gateStep('/brand/logo.svg', false)).toBe('open');
  });

  it('sends a visitor with no cookie to sign in', () => {
    expect(gateStep('/dashboard', false)).toBe('signed-out');
    expect(gateStep('/', false)).toBe('signed-out');
  });

  it('checks a cookie with the API', () => {
    expect(gateStep('/dashboard', true)).toBe('check');
  });
});

describe('isDocumentLoad', () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });

  it('is a browser asking for a page', () => {
    expect(isDocumentLoad(headers({ accept: 'text/html,application/xhtml+xml' }))).toBe(true);
  });

  it('is not a client-side navigation or a data fetch', () => {
    expect(isDocumentLoad(headers({ accept: 'text/x-component', rsc: '1' }))).toBe(false);
    expect(isDocumentLoad(headers({ accept: 'text/html', rsc: '1' }))).toBe(false);
    expect(isDocumentLoad(headers({}))).toBe(false);
  });
});

describe('checkSession', () => {
  const meUrl = new URL('http://api.example/api/v1/auth/me');
  const reply = (status: number, body?: unknown) =>
    vi.fn(() =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;

  it('sends the session as a bearer token', async () => {
    const fetchFn = reply(200, { data: {} });
    await checkSession({ meUrl, token: 'tok', fetchFn });
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('is valid when the API accepts the session', async () => {
    expect(await checkSession({ meUrl, token: 't', fetchFn: reply(200, { data: {} }) })).toBe(
      'valid',
    );
  });

  it('is rejected only on a 401 that says the session is gone', async () => {
    const gone = reply(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    expect(await checkSession({ meUrl, token: 't', fetchFn: gone })).toBe('rejected');
  });

  it('is unknown, never rejected, for anything else', async () => {
    const other = reply(401, { error: { code: 'INVALID_CREDENTIALS' } });
    expect(await checkSession({ meUrl, token: 't', fetchFn: other })).toBe('unknown');
    expect(await checkSession({ meUrl, token: 't', fetchFn: reply(401) })).toBe('unknown');
    expect(await checkSession({ meUrl, token: 't', fetchFn: reply(500) })).toBe('unknown');
    expect(await checkSession({ meUrl, token: 't', fetchFn: reply(503) })).toBe('unknown');
    expect(await checkSession({ meUrl, token: 't', fetchFn: reply(403) })).toBe('unknown');
  });

  it('is unknown when the API cannot be reached', async () => {
    const down = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    expect(await checkSession({ meUrl, token: 't', fetchFn: down })).toBe('unknown');
  });
});
