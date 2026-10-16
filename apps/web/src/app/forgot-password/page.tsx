'use client';

import { Button, Input } from '@crm/ui';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthShell } from '../../components/auth-shell';
import { t } from '../../lib/i18n';
import { requestPasswordReset } from '../../lib/session';

/**
 * Ask for a password-reset link.
 *
 * There is no error branch, because there is nothing to report: the API
 * answers identically whether or not the address has an account, so that this
 * form cannot be used to find out who does (MVP_SPEC M1). The confirmation is
 * worded to match — "if that address has an account" — rather than implying a
 * message was definitely sent.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    await requestPasswordReset(email);
    setPending(false);
    setSent(true);
  };

  const backToSignIn = (
    <Link href="/sign-in" className="font-medium text-foreground underline">
      {t('auth.forgot.back')}
    </Link>
  );

  if (sent) {
    return (
      <AuthShell
        title={t('auth.forgot.sent.title')}
        description={t('auth.forgot.sent.description')}
        footer={backToSignIn}
      >
        <p className="text-sm text-muted-foreground">{email}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.forgot.title')}
      description={t('auth.forgot.description')}
      footer={backToSignIn}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Input
          label={t('auth.email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          required
        />
        <Button type="submit" loading={pending} className="w-full">
          {t('auth.forgot.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
