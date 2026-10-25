import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, originOf } from './lib/csp';
import { imageOrigins } from './lib/brand';
import { webEnv } from './lib/env';
import { upstreamPath } from './lib/proxy-path';
import {
  SIGN_IN_PATH,
  checkSession,
  gateStep,
  isDocumentLoad,
  signInQuery,
} from './lib/session-gate';

/**
 * Send somebody without a working session to the sign-in screen, before any page is drawn (ADR-0055).
 *
 * Without this the app frame was drawn for everyone and every card on it said "Could not load this".
 * No cookie: sign-in, without saying a session ended, because there was none. A cookie, on a full page
 * load: the API is asked whether it still means anything, and only a definite "no" (401
 * `UNAUTHENTICATED`) redirects and clears the cookie. A slow or failing API changes nothing, so an
 * outage cannot sign everybody out. The cookie is cleared here because it is httpOnly, which means
 * only the server can.
 *
 * Not a security boundary: the API authenticates every call itself. This decides which screen to show.
 */
async function signInRedirect(request: NextRequest): Promise<NextResponse | null> {
  const env = webEnv();
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(env.SESSION_COOKIE_NAME)?.value;
  const step = gateStep(pathname, token !== undefined && token.length > 0);
  if (step === 'open') return null;

  let sessionEnded = false;
  if (step === 'check') {
    if (!isDocumentLoad(request.headers)) return null;

    const path = upstreamPath(['auth', 'me']);
    if (path === null || token === undefined) return null;
    const verdict = await checkSession({ meUrl: new URL(path, env.API_URL), token });
    if (verdict !== 'rejected') return null;
    sessionEnded = true;
  }

  const url = request.nextUrl.clone();
  url.pathname = SIGN_IN_PATH;
  url.search = signInQuery(pathname, { sessionEnded });
  const response = NextResponse.redirect(url);
  if (sessionEnded) {
    response.cookies.set(env.SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return response;
}

/**
 * Every page gets its own Content Security Policy (CLAUDE.md §5, ADR-0040).
 *
 * Runs before a page renders, so Next can read the nonce from the policy it is given and
 * stamp it on its own scripts. That is also why every page here is rendered per request:
 * a nonce cannot be baked into HTML built at deploy time.
 *
 * Not applied to `/api/*` (those are JSON handlers whose responses carry the static headers
 * from `next.config.ts`), to static assets, or to prefetches, which are never rendered.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const redirect = await signInRedirect(request);
  if (redirect !== null) return redirect;

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const forwarded = request.headers.get('x-forwarded-proto');
  const https =
    forwarded === null
      ? request.nextUrl.protocol === 'https:'
      : forwarded.split(',')[0]?.trim() === 'https';

  const env = webEnv();
  const policy = buildCsp({
    nonce,
    development: env.NODE_ENV === 'development',
    https,
    // The browser uploads straight to the object store on a presigned URL (CLAUDE.md §5.12).
    connectOrigins: [originOf(env.S3_PUBLIC_ENDPOINT)].filter(
      (origin): origin is string => origin !== null,
    ),
    // A configured logo or favicon on another host (ADR-0045); a local path adds nothing.
    imgOrigins: imageOrigins(env),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
