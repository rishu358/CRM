'use client';

import { Button } from '@crm/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthShell } from '../../components/auth-shell';
import { t } from '../../lib/i18n';
import { verifyEmail } from '../../lib/session';

/**
 * Confirm an email address from the link in the verification email.
 *
 * The token is single-use, so this must redeem it exactly once. React runs
 * effects twice in development Strict Mode, which would spend the token on the
 * first run and then show the user a failure from the second — the `attempted`
 * ref is what stops that.
 */
function VerifyEmail() {
  const token = useSearchParams().get('token');
  // Derived rather than set inside the effect: a link with no token is
  // already a failure at first render, and setting state synchronously in an
  // effect just to say so costs an extra render pass.
  const [state, setState] = useState<'pending' | 'done' | 'failed'>(() =>
    token === null || token.length === 0 ? 'failed' : 'pending',
  );
  const attempted = useRef(false);

  useEffect(() => {
    if (token === null || token.length === 0) return;
    if (attempted.current) return;
    attempted.current = true;

    void verifyEmail(token).then((failure) => {
      setState(failure === null ? 'done' : 'failed');
    });
  }, [token]);

  if (state === 'pending') {
    return (
      <AuthShell title={t('auth.verify.pending')}>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </AuthShell>
    );
  }

  if (state === 'failed') {
    return (
      <AuthShell
        title={t('auth.verify.failed.title')}
        description={t('auth.verify.failed.description')}
      >
        <Link href="/sign-in">
          <Button variant="outline" className="w-full">
            {t('auth.forgot.back')}
          </Button>
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.verify.done.title')} description={t('auth.verify.done.description')}>
      <Link href="/sign-in">
        <Button className="w-full">{t('auth.submit')}</Button>
      </Link>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthShell title={t('auth.verify.pending')}>{null}</AuthShell>}>
      <VerifyEmail />
    </Suspense>
  );
}
