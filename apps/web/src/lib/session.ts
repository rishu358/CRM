'use client';

/**
 * Session and account operations, called by the auth screens.
 *
 * Lives in the data layer rather than in the components, for the same reason
 * the contacts queries do: components describe what they need, not how it is
 * fetched (CLAUDE.md §9).
 *
 * Two destinations, and the difference matters. Anything that produces a
 * session token goes to `/api/session`, which turns it into an httpOnly
 * cookie server-side. Everything else goes through `/api/proxy`, which is the
 * same versioned API the public API and the mobile app will use (ADR-0007).
 */
export interface AuthFailure {
  readonly code: string;
  readonly message: string;
}

export type SignInOutcome =
  | { readonly status: 'signed_in' }
  | { readonly status: 'mfa_required'; readonly challengeToken: string }
  | { readonly status: 'failed'; readonly error: AuthFailure };

interface Envelope<T> {
  readonly data?: T;
  readonly error?: Partial<AuthFailure>;
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Envelope<T>;
  } catch {
    return {};
  }
}

function failure(body: Envelope<unknown>, fallback: string): AuthFailure {
  return {
    code: body.error?.code ?? 'INTERNAL',
    message: body.error?.message ?? fallback,
  };
}

async function postSession(payload: Record<string, string>): Promise<SignInOutcome> {
  const response = await globalThis.fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await readEnvelope<never>(response);

  if (!response.ok) {
    return { status: 'failed', error: failure(body, 'Could not sign you in') };
  }

  const status = (body as { status?: string }).status;
  if (status === 'mfa_required') {
    return {
      status: 'mfa_required',
      challengeToken: (body as { challengeToken: string }).challengeToken,
    };
  }
  return { status: 'signed_in' };
}

export async function signIn(email: string, password: string): Promise<SignInOutcome> {
  return postSession({ action: 'sign-in', email, password });
}

export async function verifyMfa(challengeToken: string, code: string): Promise<SignInOutcome> {
  return postSession({ action: 'mfa', challengeToken, code });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthFailure | null> {
  const outcome = await postSession({ action: 'change-password', currentPassword, newPassword });
  return outcome.status === 'failed' ? outcome.error : null;
}

/**
 * Accept an invitation by creating the account it was sent to.
 *
 * Through `/api/session` rather than the proxy, because this is the one
 * acceptance path that produces a session token (ADR-0018) and the token must
 * become an httpOnly cookie before the page sees a response.
 */
export async function acceptInvitationAsNewAccount(input: {
  token: string;
  name: string;
  password: string;
}): Promise<AuthFailure | null> {
  const outcome = await postSession({ action: 'accept-invitation', ...input });
  return outcome.status === 'failed' ? outcome.error : null;
}

export async function signOut(): Promise<void> {
  await globalThis.fetch('/api/session', { method: 'DELETE' });
}

/**
 * Call a versioned API endpoint through the credential proxy.
 *
 * `T` defaults to `void` because several of these endpoints answer 204 with
 * no body at all, and the callers for those only ever look at whether an
 * error came back.
 */
async function callApi<T = void>(
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<{ data: T } | { error: AuthFailure }> {
  const response = await globalThis.fetch(`/api/proxy/${path}`, {
    method: init.method,
    ...(init.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  });
  const body = await readEnvelope<T>(response);

  if (!response.ok) return { error: failure(body, 'Something went wrong') };
  return { data: body.data as T };
}

export async function signUp(input: {
  email: string;
  password: string;
  name: string;
  companyName?: string;
}): Promise<AuthFailure | null> {
  const result = await callApi('auth/sign-up', { method: 'POST', body: input });
  return 'error' in result ? result.error : null;
}

export async function requestPasswordReset(email: string): Promise<void> {
  // The response is the same whether or not the address has an account, so
  // there is nothing here worth branching on (MVP_SPEC M1).
  await callApi('auth/forgot-password', { method: 'POST', body: { email } });
}

export async function resetPassword(token: string, password: string): Promise<AuthFailure | null> {
  const result = await callApi('auth/reset-password', {
    method: 'POST',
    body: { token, password },
  });
  return 'error' in result ? result.error : null;
}

export async function verifyEmail(token: string): Promise<AuthFailure | null> {
  const result = await callApi('auth/verify-email', { method: 'POST', body: { token } });
  return 'error' in result ? result.error : null;
}

export async function resendVerification(email: string): Promise<void> {
  await callApi('auth/resend-verification', { method: 'POST', body: { email } });
}

// ---------------------------------------------------------------------------
// Security settings
// ---------------------------------------------------------------------------

export interface SessionSummaryView {
  readonly id: string;
  readonly current: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export async function listSessions(): Promise<SessionSummaryView[]> {
  const result = await callApi<SessionSummaryView[]>('auth/sessions');
  return 'error' in result ? [] : result.data;
}

export async function signOutOtherDevices(): Promise<number> {
  const result = await callApi<{ revoked: number }>('auth/sessions/others', { method: 'DELETE' });
  return 'error' in result ? 0 : result.data.revoked;
}

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly backupCodesRemaining: number;
}

export async function mfaStatus(): Promise<MfaStatus> {
  const result = await callApi<MfaStatus>('auth/mfa');
  return 'error' in result ? { enrolled: false, backupCodesRemaining: 0 } : result.data;
}

export interface MfaEnrolmentView {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly backupCodes: string[];
}

export async function beginMfaEnrolment(): Promise<MfaEnrolmentView | AuthFailure> {
  const result = await callApi<MfaEnrolmentView>('auth/mfa/enroll', { method: 'POST' });
  return 'error' in result ? result.error : result.data;
}

export async function activateMfa(code: string): Promise<AuthFailure | null> {
  const result = await callApi('auth/mfa/activate', { method: 'POST', body: { code } });
  return 'error' in result ? result.error : null;
}

export async function disableMfa(password: string): Promise<AuthFailure | null> {
  const result = await callApi('auth/mfa/disable', { method: 'POST', body: { password } });
  return 'error' in result ? result.error : null;
}

export interface CurrentUserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly memberships: { tenantId: string; name: string; roleName: string }[];
}

export async function currentUser(): Promise<CurrentUserView | null> {
  const result = await callApi<CurrentUserView>('auth/me');
  return 'error' in result ? null : result.data;
}
