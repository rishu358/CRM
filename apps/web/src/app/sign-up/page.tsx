'use client';

import { passwordProblems } from '@crm/core/auth';
import { Button, Input } from '@crm/ui';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthShell, FormError } from '../../components/auth-shell';
import { authErrorMessage } from '../../lib/auth-errors';
import { t } from '../../lib/i18n';
import { signUp } from '../../lib/session';

/**
 * Create an account.
 *
 * The password is checked here with the **same** `passwordProblems` the API
 * uses (`@crm/core/auth`), not a copy of the rules. A form that accepts what
 * the server rejects is somebody typing a password twice and being told
 * nothing useful.
 *
 * On success the screen says "check your email" whatever happened — including
 * when the address already has an account. That is deliberate and comes from
 * the API, which answers identically either way so the form cannot be used to
 * discover who has an account (MVP_SPEC M1).
 */
export default function SignUpPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const problems = passwordProblems(password);
    if (problems.length > 0) {
      setPasswordError(problems[0] ?? null);
      return;
    }
    setPasswordError(null);
    setPending(true);

    const failure = await signUp({
      email,
      password,
      name,
      ...(companyName.trim().length > 0 ? { companyName: companyName.trim() } : {}),
    });
    setPending(false);

    if (failure !== null) {
      setError(authErrorMessage(failure));
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthShell
        title={t('auth.signUp.sent.title')}
        description={t('auth.signUp.sent.description')}
        footer={
          <Link href="/sign-in" className="font-medium text-foreground underline">
            {t('auth.forgot.back')}
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">{email}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.signUp.title')}
      description={t('auth.signUp.description')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link href="/sign-in" className="font-medium text-foreground underline">
            {t('auth.title')}
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <FormError message={error} />
        <Input
          label={t('auth.signUp.name')}
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          required
        />
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
          onChange={(event) => {
            setPassword(event.target.value);
            if (passwordError !== null) setPasswordError(null);
          }}
          autoComplete="new-password"
          error={passwordError ?? undefined}
          hint={t('auth.error.passwordPolicy')}
          required
        />
        <Input
          label={t('auth.signUp.company')}
          name="companyName"
          value={companyName}
          onChange={(event) => setCompanyName(event.target.value)}
          autoComplete="organization"
          hint={t('auth.signUp.companyHint')}
        />
        <Button type="submit" loading={pending} className="w-full">
          {t('auth.signUp.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
