import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { webEnv } from '../../../lib/env';

/**
 * Stores a session token in an httpOnly cookie, and clears it on sign-out.
 *
 * **Interim.** This does not authenticate anybody: it accepts a token that the
 * API must already recognise, verifies it by calling the API, and then keeps it
 * out of JavaScript's reach. Email and password, MFA, Google sign-in and
 * password reset arrive with the auth module (ADR-0014, MVP_SPEC M1); nothing
 * here mints a session or checks a credential, deliberately, because that is
 * exactly the code that should not be improvised.
 */
const bodySchema = z.object({ token: z.string().min(16).max(512) }).strict();

export async function POST(request: NextRequest) {
  const env = webEnv();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  // Confirm the API accepts it before storing anything, so a bad paste gives
  // an error here rather than a confusing failure on the next screen.
  const probe = await fetch(new URL('/api/v1/contacts?limit=1', env.API_URL), {
    headers: { authorization: `Bearer ${parsed.data.token}` },
    cache: 'no-store',
  });

  if (probe.status === 401) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  (await cookies()).set(env.SESSION_COOKIE_NAME, parsed.data.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * env.SESSION_TTL_DAYS,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  (await cookies()).delete(webEnv().SESSION_COOKIE_NAME);
  return NextResponse.json({ ok: true });
}
