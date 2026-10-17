'use client';

import { passwordProblems } from '@crm/core/auth';
import { Button, Input } from '@crm/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthShell, FormError } from './auth-shell';
import { t } from '../lib/i18n';
import { previewInvitation, type InvitationPreviewView } from '../lib/invitations';
import { acceptInvitation } from '../lib/invitations';
import { acceptInvitationAsNewAccount, signOut } from '../lib/session';

/**
 * The screen an invitation link lands on (MVP_SPEC M2, ADR-0019).
 *
 * One link, three outcomes, and which one you get depends on who you are — so
 * the screen asks the API first and renders what it is told, rather than
 * guessing from the URL:
 *
 *   * the address has no account — set a name and a password, and you are in
 *   * the address has an account — sign in first; the link is still waiting
 *   * you are signed in as somebody else — nothing happens, and the real
 *     recipient can still use the link
 *
 * The preview call consumes nothing. Only the button at the end of the form
 * does, which is why a reload, a double-click or a Strict Mode double effect
 * cannot spend somebody's invitation.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; preview: InvitationPreviewView }
  | { kind: 'joined'; workspaceName: string };

export function AcceptInvite() {
  const router = useRouter();
  const token = useSearchParams().get('token');

  const [state, setState] = useState<State>(() =>
    token === null || token.length === 0 ? { kind: 'invalid' } : { kind: 'loading' },
  );
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (token === null || token.length === 0) return;
    let cancelled = false;

    void previewInvitation(token)
      .then((preview) => {
        if (!cancelled) setState({ kind: 'ready', preview });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'invalid' });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <AuthShell title={t('invite.loading')}>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </AuthShell>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <AuthShell
        title={t('invite.invalid.title')}
        description={
          token === null || token.length === 0
            ? t('invite.missingToken')
            : t('invite.invalid.description')
        }
      >
        <Link href="/sign-in">
          <Button variant="outline" className="w-full">
            {t('auth.forgot.back')}
          </Button>
        </Link>
      </AuthShell>
    );
  }

  if (state.kind === 'joined') {
    return (
      <AuthShell title={t('invite.done.title', { workspace: state.workspaceName })}>
        <Link href="/contacts">
          <Button className="w-full">{t('invite.done.action')}</Button>
        </Link>
      </AuthShell>
    );
  }

  const { preview } = state;
  const safeToken = token ?? '';

  // Signed in as the wrong person. Nothing is offered but a way out, because
  // nothing else would work: the API refuses this, and the invitation stays
  // where it is (ADR-0019).
  if (preview.signedInAs !== null && !preview.canAccept) {
    return (
      <AuthShell
        title={t('invite.mismatch.title')}
        description={t('invite.mismatch.description', {
          invited: preview.email,
          current: preview.signedInAs,
        })}
      >
        <Button
          variant="outline"
          className="w-full"
          loading={pending}
          onClick={() => {
            setPending(true);
            void signOut().then(() => {
              router.refresh();
              setPending(false);
            });
          }}
        >
          {t('invite.mismatch.action')}
        </Button>
      </AuthShell>
    );
  }

  // Signed out, and the address already has an account. An emailed link never
  // issues a session for an account that already exists, so the only honest
  // next step is to sign in.
  if (preview.signedInAs === null && !preview.requiresAccount) {
    return (
      <AuthShell
        title={t('invite.signIn.title')}
        description={t('invite.signIn.description', { workspace: preview.workspaceName })}
      >
        <Link href="/sign-in">
          <Button className="w-full">{t('invite.signIn.action')}</Button>
        </Link>
      </AuthShell>
    );
  }

  // Signed in as the recipient: one button, no credentials to collect.
  if (preview.signedInAs !== null) {
    const acceptAsSelf = async () => {
      setPending(true);
      setError(null);
      try {
        await acceptInvitation(safeToken);
        setState({ kind: 'joined', workspaceName: preview.workspaceName });
      } catch {
        setError(t('error.generic'));
      } finally {
        setPending(false);
      }
    };

    return (
      <AuthShell
        title={t('invite.title', { workspace: preview.workspaceName })}
        description={t('invite.description', {
          workspace: preview.workspaceName,
          role: preview.roleName,
        })}
      >
        <div className="space-y-4">
          <FormError message={error} />
          <p className="text-sm text-muted-foreground">{preview.signedInAs}</p>
          <Button className="w-full" loading={pending} onClick={() => void acceptAsSelf()}>
            {t('invite.accept.submit')}
          </Button>
        </div>
      </AuthShell>
    );
  }

  // Nobody signed in and no account at that address: create one.
  const problems = passwordProblems(password);

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (problems.length > 0) {
      setError(t('auth.error.passwordPolicy'));
      return;
    }

    setPending(true);
    setError(null);
    const failure = await acceptInvitationAsNewAccount({ token: safeToken, name, password });
    setPending(false);

    if (failure !== null) {
      setError(
        failure.code === 'INVALID_TOKEN' ? t('invite.invalid.description') : t('error.generic'),
      );
      return;
    }

    // The session is in a cookie now, set by `/api/session` server-side.
    router.push('/contacts');
    router.refresh();
  };

  return (
    <AuthShell
      title={t('invite.title', { workspace: preview.workspaceName })}
      description={t('invite.description', {
        workspace: preview.workspaceName,
        role: preview.roleName,
      })}
    >
      <form onSubmit={(event) => void createAccount(event)} className="space-y-4">
        <FormError message={error} />
        <Input
          label={t('auth.email')}
          name="email"
          type="email"
          value={preview.email}
          // The address comes from the invitation, not from the person opening
          // it. Letting it be edited would be letting somebody redirect
          // another workspace's invitation to themselves.
          readOnly
          autoComplete="username"
        />
        <Input
          label={t('invite.create.name')}
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          required
        />
        <Input
          label={t('invite.create.password')}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          hint={t('auth.error.passwordPolicy')}
        />
        <Button type="submit" loading={pending} className="w-full">
          {t('invite.create.submit', { workspace: preview.workspaceName })}
        </Button>
      </form>
    </AuthShell>
  );
}
