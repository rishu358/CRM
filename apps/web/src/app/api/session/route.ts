import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { webEnv } from '../../../lib/env';

/**
 * Sign in, finish an MFA challenge, change a password, accept an invitation
 * as a new account, sign out.
 *
 * These are handled here rather than through `/api/proxy/*` for one
 * reason: they are the requests whose response contains a session token, and
 * the token must be turned into an httpOnly cookie on *this* origin before it
 * ever reaches the page. The proxy deliberately drops `Set-Cookie`, so a
 * sign-in routed through it would authenticate and then lose the session.
 *
 * Nothing here decides anything. The API checks the password, the second
 * factor and the throttle; this handler forwards, moves a token into a cookie
 * and returns a body with no token in it. The browser never sees the session
 * value, which is the whole point — a token page script can read is a token
 * that ends up in `localStorage`, and that is where XSS goes shopping.
 */
const signInSchema = z
  .object({
    action: z.literal('sign-in'),
    email: z.string().min(1).max(320),
    password: z.string().min(1).max(200),
  })
  .strict();

const mfaSchema = z
  .object({
    action: z.literal('mfa'),
    challengeToken: z.string().min(16).max(512),
    code: z.string().min(6).max(20),
  })
  .strict();

const changePasswordSchema = z
  .object({
    action: z.literal('change-password'),
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(1).max(200),
  })
  .strict();

/**
 * Accepting an invitation with a brand-new account.
 *
 * Only this shape of acceptance comes here. Accepting from an account that
 * already exists issues no session, so it is an ordinary `/api/proxy` call;
 * this one creates the account and signs it in, and that token must become a
 * cookie before the page ever sees a response (ADR-0019).
 *
 * The token carries the workspace and the role. Neither is in this body, and
 * the API would refuse them if they were.
 */
const acceptInvitationSchema = z
  .object({
    action: z.literal('accept-invitation'),
    token: z.string().min(40).max(512),
    name: z.string().min(1).max(120),
    password: z.string().min(1).max(200),
  })
  .strict();

const bodySchema = z.discriminatedUnion('action', [
  signInSchema,
  mfaSchema,
  changePasswordSchema,
  acceptInvitationSchema,
]);

/**
 * Reject a cross-site state-changing request (CLAUDE.md §5.9).
 *
 * This route sets the session cookie, so a cross-site POST here would be
 * worse than one to the proxy, not better. Origin is set by the browser on
 * every cross-origin request and page script cannot forge it.
 */
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

interface ApiEnvelope {
  readonly data?: { status?: string; token?: string; challengeToken?: string };
  readonly error?: { code?: string; message?: string };
}

/** Relay the API's status and error code, but never its token. */
function relay(upstream: Response, payload: ApiEnvelope): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: payload.error?.code ?? 'INTERNAL',
        message: payload.error?.message ?? 'Something went wrong',
      },
    },
    { status: upstream.status },
  );
}

async function setSessionCookie(token: string): Promise<void> {
  const env = webEnv();
  (await cookies()).set(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * env.SESSION_TTL_DAYS,
  });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Cross-site request refused' } },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Check the form and try again' } },
      { status: 422 },
    );
  }

  const env = webEnv();
  const body = parsed.data;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Changing a password is the one action here that needs an existing
  // session: the API re-checks the current password against it.
  if (body.action === 'change-password') {
    const token = (await cookies()).get(env.SESSION_COOKIE_NAME)?.value;
    if (token === undefined) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } },
        { status: 401 },
      );
    }
    headers['authorization'] = `Bearer ${token}`;
  }

  const { path, payload } = upstreamCall(body);
  const upstream = await fetch(new URL(path, env.API_URL), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  // 204 on a password change: the new session arrives as a Set-Cookie we
  // cannot read through fetch, so the API also returns it in the body for
  // exactly this case. Anything without a body is a failure to relay.
  const text = await upstream.text();
  const envelope = (text.length === 0 ? {} : JSON.parse(text)) as ApiEnvelope;

  if (!upstream.ok) return relay(upstream, envelope);

  if (envelope.data?.status === 'mfa_required') {
    // Returned to the page so the next step can carry it. It is single-use,
    // expires in five minutes, and is worthless without the authenticator.
    return NextResponse.json({
      status: 'mfa_required',
      challengeToken: envelope.data.challengeToken,
    });
  }

  const token = envelope.data?.token;
  if (typeof token === 'string') await setSessionCookie(token);

  return NextResponse.json({ status: 'signed_in' });
}

function upstreamCall(body: z.infer<typeof bodySchema>): {
  path: string;
  payload: Record<string, string>;
} {
  switch (body.action) {
    case 'sign-in':
      return {
        path: '/api/v1/auth/sign-in',
        payload: { email: body.email, password: body.password },
      };
    case 'mfa':
      return {
        path: '/api/v1/auth/mfa/verify',
        payload: { challengeToken: body.challengeToken, code: body.code },
      };
    case 'change-password':
      return {
        path: '/api/v1/auth/change-password',
        payload: { currentPassword: body.currentPassword, newPassword: body.newPassword },
      };
    case 'accept-invitation':
      return {
        path: '/api/v1/invitations/accept',
        payload: { token: body.token, name: body.name, password: body.password },
      };
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Cross-site request refused' } },
      { status: 403 },
    );
  }

  const env = webEnv();
  const jar = await cookies();
  const token = jar.get(env.SESSION_COOKIE_NAME)?.value;

  // Revoke server-side as well as locally. Clearing only the cookie would
  // leave a live session behind that a stolen token could still use.
  if (token !== undefined) {
    await fetch(new URL('/api/v1/auth/sign-out', env.API_URL), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => undefined);
  }

  jar.delete(env.SESSION_COOKIE_NAME);
  return NextResponse.json({ ok: true });
}
