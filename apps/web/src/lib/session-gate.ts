/**
 * Who may see a page, and where a person whose session has ended is sent (ADR-0055).
 *
 * Pure functions with no environment and no framework import, so the same rules are used by the
 * proxy (`proxy.ts`, on a full page load) and by the browser (`session-ended.ts`, when a call
 * answers that the session is gone) and can be tested without either.
 *
 * Nothing here is a security boundary. The API authenticates and authorizes every call; this only
 * decides which screen a person sees when it has said no. Hiding a page is cosmetic (CLAUDE.md §5).
 */

export const SIGN_IN_PATH = '/sign-in';
export const DEFAULT_LANDING_PATH = '/dashboard';

/** The one `reason` the sign-in screen understands. Anything else in the URL is ignored. */
export const SESSION_ENDED_REASON = 'session-ended';

/**
 * Pages that work without a session. Everything else needs one: a page added later is protected
 * until somebody lists it here on purpose, the same default as `@Public()` in the API.
 */
const PUBLIC_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/accept-invite',
] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * A request for a file (a configured logo under `/brand/logo.svg`, say) rather than a page.
 * None of this app's routes has a dot in its last segment, and a logo has to load on the sign-in
 * screen, where there is no session.
 */
export function isFilePath(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]{1,8}$/.test(last);
}

/**
 * Did the API say that the session itself is gone?
 *
 * Keyed on the **code**, never on the status alone: a wrong password is also a 401
 * (`INVALID_CREDENTIALS`) and must stay a message on the form, not a trip to the sign-in screen.
 * The API answers every kind of dead session identically (missing, unknown, revoked, expired,
 * superseded by a password change, deleted user), on purpose, so there is nothing finer to branch on.
 */
export function isSessionEnded(status: number, code: string | undefined): boolean {
  return status === 401 && code === 'UNAUTHENTICATED';
}

const MAX_RETURN_TO_LENGTH = 512;

/** Control characters and DEL, which have no place in a path and are how filters get confused. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Where to send somebody after they sign in, or `null` if the value cannot be trusted.
 *
 * Only a path on this site is ever returned: no scheme, no host, no query, no fragment. The value
 * comes from the address bar, so it is whatever a stranger put in a link, and `//host` or
 * `/\host` would be an open redirect. The path is parsed and the *parsed* pathname checked, because
 * `/.//host` normalises to `//host`. The query is dropped on purpose: it can hold search terms and
 * names, and the sign-in URL ends up in history and logs.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value.includes('\\') || hasControlCharacter(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, 'http://crm.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'http://crm.invalid') return null;

  const { pathname } = parsed;
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  if (isPublicPath(pathname) || pathname === '/api' || pathname.startsWith('/api/')) return null;
  return pathname;
}

/**
 * The query string for the sign-in screen: why the person is there and where they were.
 * Empty when there is nothing to say.
 */
export function signInQuery(from: string, options: { sessionEnded: boolean }): string {
  const params = new URLSearchParams();
  if (options.sessionEnded) params.set('reason', SESSION_ENDED_REASON);
  const returnTo = safeReturnTo(from);
  if (returnTo !== null && returnTo !== '/') params.set('returnTo', returnTo);
  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
}

/** What a full page load of a protected page should do first. */
export type GateStep = 'open' | 'signed-out' | 'check';

export function gateStep(pathname: string, hasCookie: boolean): GateStep {
  if (isPublicPath(pathname) || isFilePath(pathname)) return 'open';
  return hasCookie ? 'check' : 'signed-out';
}

/**
 * Only a document request is worth an API call. A client-side navigation or a data fetch carries
 * the `rsc` header and is covered by the browser handler when its own calls come back 401.
 */
export function isDocumentLoad(headers: { get(name: string): string | null }): boolean {
  if (headers.get('rsc') !== null) return false;
  return (headers.get('accept') ?? '').includes('text/html');
}

/**
 * `valid`: the API accepted the session. `rejected`: it said the session is gone. `unknown`: it
 * could not be asked (down, slow, an error of its own). Only `rejected` ever clears a cookie or
 * redirects: an outage must not sign everybody out.
 */
export type SessionVerdict = 'valid' | 'rejected' | 'unknown';

export const SESSION_CHECK_TIMEOUT_MS = 3000;

export async function checkSession(options: {
  meUrl: URL;
  token: string;
  /** Who is really asking, so the API's per-address ceiling counts the person, not this server. */
  clientAddress?: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<SessionVerdict> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(options.meUrl, {
      method: 'GET',
      headers: { ...options.clientAddress, authorization: `Bearer ${options.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (response.ok) return 'valid';
    if (response.status !== 401) return 'unknown';

    const body: unknown = await response.json().catch(() => null);
    const code =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
    return isSessionEnded(response.status, typeof code === 'string' ? code : undefined)
      ? 'rejected'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
