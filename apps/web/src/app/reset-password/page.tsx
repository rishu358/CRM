'use client';

import { passwordProblems } from '@crm/core/auth';
import { Button, Input } from '@crm/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthShell, FormError } from '../../components/auth-shell';
import { authErrorMessage } from '../../lib/auth-errors';
import { t } from '../../lib/i18n';
import { resetPassword } from '../../lib/session';

/**
 * Choose a new password from a reset link.
 *
 * The token comes from the query string because that is where the email put
 * it, and it is never rendered, logged or put in a form field — it goes
 * straight back to the API. The confirm field is a client-side nicety, not a
 * rule the server knows about; the real policy is `passwordProblems`, shared
 * with the API so the two cannot disagree.
 */
function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const backToSignIn = (
    <Link href="/sign-in" className="font-medium text-foreground underline">
      {t('auth.forgot.back')}
    </Link>
  );

  if (token === null || token.length === 0) {
    return (
      <AuthShell
        title={t('auth.reset.title')}
        description={t('auth.reset.missingToken')}
        footer={backToSignIn}
      >
        <Link href="/forgot-password" className="text-sm underline">
          {t('auth.forgot.submit')}
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title={t('auth.reset.done.title')}
        description={t('auth.reset.done.description')}
        footer={backToSignIn}
      >
        <Link href="/sign-in">
          <Button className="w-full">{t('auth.submit')}</Button>
        </Link>
      </AuthShell>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setFieldError(t('auth.reset.mismatch'));
      return;
    }
    const problems = passwordProblems(password);
    if (problems.length > 0) {
      setFieldError(problems[0] ?? null);
      return;
    }

    setFieldError(null);
    setPending(true);
    const failure = await resetPassword(token, password);
    setPending(false);

    if (failure !== null) {
      setError(authErrorMessage(failure));
      return;
    }
    setDone(true);
  };

  return (
    <AuthShell
      title={t('auth.reset.title')}
      description={t('auth.reset.description')}
      footer={backToSignIn}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <FormError message={error} />
        <Input
          label={t('auth.reset.password')}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          hint={t('auth.error.passwordPolicy')}
          required
        />
        <Input
          label={t('auth.reset.confirm')}
          name="confirm"
          type="password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            if (fieldError !== null) setFieldError(null);
          }}
          autoComplete="new-password"
          error={fieldError ?? undefined}
          required
        />
        <Button type="submit" loading={pending} className="w-full">
          {t('auth.reset.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}

/**
 * `useSearchParams` makes the page client-rendered, which Next requires a
 * Suspense boundary for. The fallback is the same frame, so the layout does
 * not jump when the token is read.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthShell title={t('auth.reset.title')}>{null}</AuthShell>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
