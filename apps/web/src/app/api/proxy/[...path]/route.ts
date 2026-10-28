import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { clientAddressHeaders } from '../../../../lib/client-address';
import { PUBLIC_FORM_BODY_MAX_BYTES } from '@crm/core';
import { webEnv } from '../../../../lib/env';
import { upstreamPath } from '../../../../lib/proxy-path';

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
const FORWARDED_REQUEST_HEADERS = ['content-type', 'x-tenant-id', 'idempotency-key'];
/** The same for a public route: a workspace id from a visitor is not something to pass on. */
const PUBLIC_FORWARDED_REQUEST_HEADERS = ['content-type', 'idempotency-key'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'retry-after'];

/** Methods that change state and therefore need CSRF defence. */
const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Reject a cross-site state-changing request (CLAUDE.md §5.9).
 *
 * This route authenticates by cookie, which makes it a CSRF target: without a
 * check, any page on the internet could POST here and the browser would attach
 * the session. SameSite=Lax already blocks the cookie on a cross-site POST;
 * this is the second lock, because a single cookie attribute is a thin place
 * for the whole defence to live.
 *
 * Checking Origin rather than a token keeps it stateless. Origin is set by the
 * browser on every cross-origin request and cannot be forged by page script.
 */
function isSameOrigin(request: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return true;

  const origin = request.headers.get('origin');
  // A same-origin fetch from our own pages always sends Origin. Its absence on
  // a state-changing request is not something a browser does, so refuse.
  if (origin === null) return false;

  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

async function forward(request: NextRequest, segments: string[]): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Cross-site request refused',
          details: [],
          requestId: '',
        },
      },
      { status: 403 },
    );
  }

  const env = webEnv();

  // The public lead-form routes (ADR-0063) are for strangers: no credential of any kind goes with
  // them, whatever this visitor's browser holds (a signed-in administrator previewing a form is
  // still, to the API, nobody), and a body over the cap is refused before it is read.
  const isPublic = segments[0] === 'public';
  if (isPublic) {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > PUBLIC_FORM_BODY_MAX_BYTES) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request body is too large',
            details: [],
            requestId: '',
          },
        },
        { status: 413 },
      );
    }
  }
  const token = isPublic ? undefined : (await cookies()).get(env.SESSION_COOKIE_NAME)?.value;

  // Rebuilt from the matched segments, never from a raw string, and refused if any of them
  // could leave /api/v1 (a dot segment, a separator): see `upstreamPath`.
  const path = upstreamPath(segments);
  if (path === null) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid path',
          details: [],
          requestId: '',
        },
      },
      { status: 400 },
    );
  }
  const target = new URL(path, env.API_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of isPublic ? PUBLIC_FORWARDED_REQUEST_HEADERS : FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  // The API's address limits are about the person, not this server (ADR-0053).
  for (const [name, value] of Object.entries(clientAddressHeaders(request.headers))) {
    headers.set(name, value);
  }

  const body =
    request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text();

  // A body that did not declare its length is measured once it is read.
  if (isPublic && body !== undefined && Buffer.byteLength(body) > PUBLIC_FORM_BODY_MAX_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body is too large',
          details: [],
          requestId: '',
        },
      },
      { status: 413 },
    );
  }

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
