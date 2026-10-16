'use client';

import { Button, Input } from '@crm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthShell, FormError } from '../../components/auth-shell';
import { authErrorMessage } from '../../lib/auth-errors';
import { t } from '../../lib/i18n';
import { signIn, verifyMfa } from '../../lib/session';

/**
 * Sign in with email and password, then a second factor when one is enrolled.
 *
 * Two steps in one screen rather than two routes: the challenge token is held
 * in component state and dies with the tab, which is what we want for a
 * credential that lives five minutes. Putting it in the URL would park it in
 * browser history and in any referrer the next page sends.
 *
 * Nothing here decides anything. The API checks the password, the code and
 * the throttle; this screen collects input and reports what came back.
 */
type Step = { kind: 'credentials' } | { kind: 'mfa'; challengeToken: string };

export default function SignInPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const goToApp = () => {
    router.push('/contacts');
    router.refresh();
  };

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const outcome = await signIn(email, password);
    setPending(false);

    if (outcome.status === 'failed') {
      setError(authErrorMessage(outcome.error));
      return;
    }
    if (outcome.status === 'mfa_required') {
      setStep({ kind: 'mfa', challengeToken: outcome.challengeToken });
      return;
    }
    goToApp();
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'mfa') return;

    setPending(true);
    setError(null);

    const outcome = await verifyMfa(step.challengeToken, code);
    setPending(false);

    if (outcome.status === 'failed') {
      setError(authErrorMessage(outcome.error));
      // The challenge token is single-use, so a failed code means starting
      // again rather than retyping into a token the server has discarded.
      setStep({ kind: 'credentials' });
      setPassword('');
      setCode('');
      return;
    }
    goToApp();
  };

  if (step.kind === 'mfa') {
    return (
      <AuthShell title={t('auth.mfa.title')} description={t('auth.mfa.description')}>
        <form onSubmit={(event) => void submitCode(event)} className="space-y-4">
          <FormError message={error} />
          <Input
            label={t('auth.mfa.code')}
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            // `one-time-code` lets a phone offer the code from its messages or
            // its authenticator, which is the difference between tapping once
            // and switching apps to copy six digits.
            autoComplete="one-time-code"
            inputMode="text"
            required
            hint={t('auth.mfa.backupHint')}
          />
          <Button type="submit" loading={pending} className="w-full">
            {t('auth.mfa.submit')}
          </Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.title')}
      description={t('auth.description')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link href="/sign-up" className="font-medium text-foreground underline">
            {t('auth.createAccount')}
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void submitCredentials(event)} className="space-y-4">
        <FormError message={error} />
        <Input
          label={t('auth.email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          required
        />
        <Input
          label={t('auth.password')}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
        <Button type="submit" loading={pending} className="w-full">
          {t('auth.submit')}
        </Button>
        <div className="text-center text-sm">
          <Link href="/forgot-password" className="text-muted-foreground underline">
            {t('auth.forgot')}
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
