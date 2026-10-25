import { SignInForm } from '../../components/sign-in-form';
import { DEFAULT_LANDING_PATH, SESSION_ENDED_REASON, safeReturnTo } from '../../lib/session-gate';

/**
 * The sign-in screen. A server component so that `returnTo` is checked before it reaches the
 * browser: it comes from the address bar, so it is whatever a link put there (ADR-0055).
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnTo = params['returnTo'];

  return (
    <SignInForm
      sessionEnded={params['reason'] === SESSION_ENDED_REASON}
      returnTo={
        safeReturnTo(typeof returnTo === 'string' ? returnTo : null) ?? DEFAULT_LANDING_PATH
      }
    />
  );
}
