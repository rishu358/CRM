import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, originOf } from './lib/csp';
import { webEnv } from './lib/env';

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
export function proxy(request: NextRequest): NextResponse {
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
