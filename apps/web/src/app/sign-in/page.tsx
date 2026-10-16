'use client';

import { Button, Card, CardBody, CardHeader, Input } from '@crm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '../../lib/i18n';
import { startSession } from '../../lib/session';

/**
 * Interim sign-in.
 *
 * Accepts a session token printed by `pnpm db:seed` and hands it to the route
 * handler, which verifies it against the API and stores it in an httpOnly
 * cookie. Nothing here mints a session or checks a credential — email and
 * password, MFA, Google sign-in and password reset arrive with the auth module
 * (ADR-0014, MVP_SPEC M1). Improvising that is exactly what ADR-0014 exists to
 * prevent, so this screen deliberately does less rather than more.
 */
export default function SignInPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const started = await startSession(token);

    setPending(false);
    if (started) {
      router.push('/contacts');
      router.refresh();
    } else {
      setError(t('auth.invalid'));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader title={t('auth.title')} description={t('auth.description')} />
        <CardBody>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <Input
              label={t('auth.token')}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              error={error ?? undefined}
            />
            <Button type="submit" loading={pending} className="w-full">
              {t('auth.submit')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
