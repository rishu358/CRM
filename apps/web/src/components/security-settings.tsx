'use client';

import { passwordProblems } from '@crm/core/auth';
import { Badge, Button, Card, CardBody, CardHeader, Input, Skeleton } from '@crm/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { FormError, FormNotice } from './auth-shell';
import { authErrorMessage } from '../lib/auth-errors';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import {
  activateMfa,
  beginMfaEnrolment,
  changePassword,
  disableMfa,
  listSessions,
  mfaStatus,
  signOutOtherDevices,
  type MfaEnrolmentView,
  type SessionSummaryView,
} from '../lib/session';

/**
 * The security screen: password, second factor, signed-in devices.
 *
 * Server state through TanStack Query like every other screen, so the device
 * list and the MFA status refresh themselves after an action rather than
 * needing the page reloaded (CLAUDE.md §9).
 *
 * Nothing on this screen is a security control. Hiding the "turn off MFA"
 * button would not stop anybody — the API requires the password for it
 * regardless. The UI exists to make the state legible, not to enforce it.
 */
export function SecuritySettings() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">{t('security.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('security.description')}</p>
      </header>
      <PasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const problems = passwordProblems(next);
    if (problems.length > 0) {
      setFieldError(problems[0] ?? null);
      return;
    }
    setFieldError(null);
    setPending(true);

    const failure = await changePassword(current, next);
    setPending(false);

    if (failure !== null) {
      setError(authErrorMessage(failure));
      return;
    }

    setCurrent('');
    setNext('');
    setNotice(t('security.password.done'));
    // Every other device was just signed out, so the list on screen is stale.
    await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  };

  return (
    <Card>
      <CardHeader title={t('security.password.title')} />
      <CardBody>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <FormError message={error} />
          <FormNotice message={notice} />
          <Input
            label={t('security.password.current')}
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            required
          />
          <Input
            label={t('security.password.new')}
            type="password"
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
              if (fieldError !== null) setFieldError(null);
            }}
            autoComplete="new-password"
            hint={t('auth.error.passwordPolicy')}
            error={fieldError ?? undefined}
            required
          />
          <Button type="submit" loading={pending}>
            {t('security.password.submit')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function MfaCard() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['auth', 'mfa'], queryFn: mfaStatus });

  const [enrolment, setEnrolment] = useState<MfaEnrolmentView | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'mfa'] });
  };

  const begin = async () => {
    setError(null);
    setPending(true);
    const result = await beginMfaEnrolment();
    setPending(false);
    if ('secret' in result) setEnrolment(result);
    else setError(authErrorMessage(result));
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    const failure = await activateMfa(code);
    setPending(false);
    if (failure !== null) {
      setError(authErrorMessage(failure));
      return;
    }
    setEnrolment(null);
    setCode('');
    await refresh();
  };

  const turnOff = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    const failure = await disableMfa(password);
    setPending(false);
    if (failure !== null) {
      setError(authErrorMessage(failure));
      return;
    }
    setPassword('');
    setDisabling(false);
    await refresh();
  };

  if (status.isPending) {
    return (
      <Card>
        <CardHeader title={t('security.mfa.title')} />
        <CardBody>
          <Skeleton className="h-10 w-full" />
        </CardBody>
      </Card>
    );
  }

  const enrolled = status.data?.enrolled === true;

  return (
    <Card>
      <CardHeader
        title={t('security.mfa.title')}
        actions={enrolled ? <Badge>{t('security.mfa.on')}</Badge> : null}
      />
      <CardBody className="space-y-4">
        <FormError message={error} />

        {enrolment !== null ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('security.mfa.scan')}</p>
            {/*
              The setup key in text, not only a QR code. A QR image needs a
              dependency and a camera; the key works on a desktop with no
              phone camera pointed at it, and every authenticator accepts one.
            */}
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('security.mfa.secret')}
              </div>
              <code className="mt-1 block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">
                {enrolment.secret}
              </code>
            </div>

            <div>
              <div className="text-sm font-medium">{t('security.mfa.backupTitle')}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('security.mfa.backupDescription')}
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
                {enrolment.backupCodes.map((backupCode) => (
                  <li key={backupCode} className="rounded bg-muted px-2 py-1">
                    {backupCode}
                  </li>
                ))}
              </ul>
            </div>

            <form onSubmit={(event) => void confirm(event)} className="space-y-3">
              <Input
                label={t('auth.mfa.code')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                required
              />
              <Button type="submit" loading={pending}>
                {t('security.mfa.confirm')}
              </Button>
            </form>
          </div>
        ) : disabling ? (
          <form onSubmit={(event) => void turnOff(event)} className="space-y-3">
            <Input
              label={t('security.mfa.disableConfirm')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" loading={pending}>
                {t('security.mfa.disable')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDisabling(false)}>
                {t('field.cancel')}
              </Button>
            </div>
          </form>
        ) : enrolled ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('security.mfa.remaining', {
                count: status.data?.backupCodesRemaining ?? 0,
              })}
            </p>
            <Button variant="outline" onClick={() => setDisabling(true)}>
              {t('security.mfa.disable')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('security.mfa.off')}</p>
            <Button onClick={() => void begin()} loading={pending}>
              {t('security.mfa.enable')}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: listSessions });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const signOutOthers = async () => {
    setPending(true);
    const revoked = await signOutOtherDevices();
    setPending(false);
    setNotice(t('security.sessions.signedOut', { count: revoked }));
    await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  };

  const rows: SessionSummaryView[] = sessions.data ?? [];
  const others = rows.filter((row) => !row.current).length;

  return (
    <Card>
      <CardHeader title={t('security.sessions.title')} />
      <CardBody className="space-y-4">
        <FormNotice message={notice} />

        {sessions.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">
                      {row.userAgent ?? t('security.sessions.unknownDevice')}
                    </span>
                    {row.current ? <Badge>{t('security.sessions.current')}</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {row.ipAddress ?? ''}{' '}
                    {row.lastSeenAt === null
                      ? `${t('security.sessions.started')} ${formatDateTime(row.createdAt, DEFAULT_PREFERENCES)}`
                      : `${t('security.sessions.lastSeen')} ${formatDateTime(row.lastSeenAt, DEFAULT_PREFERENCES)}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {others === 0 ? (
          <p className="text-sm text-muted-foreground">{t('security.sessions.onlyThis')}</p>
        ) : (
          <Button variant="outline" onClick={() => void signOutOthers()} loading={pending}>
            {t('security.sessions.signOutOthers')}
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
