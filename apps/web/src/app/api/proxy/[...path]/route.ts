import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { webEnv } from '../../../../lib/env';

/**
 * Attaches the session token to API calls, server-side.
 *
 * The token lives in an httpOnly cookie on this origin, so page scripts cannot
 * read it and an XSS flaw cannot exfiltrate it. This handler forwards to the
 * same `/api/v1` endpoints every other client uses — it adds no behaviour of
 * its own, and in particular makes no authorization decisions (ADR-0007).
 *
 * The forwarded path is reconstructed from the route segments rather than from
 * a client-supplied string, so it cannot be pointed at another host.
 */
/** Headers worth passing through. Everything else is dropped deliberately. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'x-tenant-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id'];

async function forward(request: NextRequest, segments: string[]): Promise<NextResponse> {
  const env = webEnv();
  const token = (await cookies()).get(env.SESSION_COOKIE_NAME)?.value;

  // Rebuilt from the matched segments, never from a raw string, so no caller
  // can traverse out of /api/v1 or aim this at a different origin.
  const path = segments.map(encodeURIComponent).join('/');
  const target = new URL(`/api/v1/${path}`, env.API_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);

  const body =
    request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text();

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(body === undefined || body.length === 0 ? {} : { body }),
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }

  const payload = await upstream.arrayBuffer();
  return new NextResponse(payload.byteLength === 0 ? null : payload, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
