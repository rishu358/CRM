'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorState,
  MailIcon,
  NoPermissionState,
  Skeleton,
} from '@crm/ui';
import { useState } from 'react';
import {
  useEmailSuppressions,
  useLiftEmailSuppression,
  useResumeEmail,
  type EmailSettings,
  type EmailSuppression,
} from '../lib/emails';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * Blocked addresses and the pause, on Settings > Email (ADR-0075).
 *
 * Both are written by the system from what the mail service reports; people only look, and end them. Who
 * may look and who may change is the API's answer (`tenant_settings`), so a 403 here is a state, not a
 * guess from a role. A bounce can be unblocked once the address has been corrected; a complaint or an
 * unsubscribe is the person's own refusal and has no button, and the API and the database refuse it too.
 */
export function EmailPauseBanner({ paused }: { paused: NonNullable<EmailSettings['paused']> }) {
  const resume = useResumeEmail();
  return (
    <Card data-testid="email-paused-banner">
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-destructive">{t('email.paused.title')}</p>
            <p className="text-sm text-muted-foreground">
              {t(`email.paused.reason.${paused.reason}`)}{' '}
              {t('email.paused.since', {
                when: formatDateTime(paused.since, DEFAULT_PREFERENCES),
              })}
            </p>
            {resume.isError ? (
              <p role="alert" className="mt-1 text-sm text-destructive">
                {t('email.paused.resume.error')}
              </p>
            ) : null}
          </div>
          <Button loading={resume.isPending} onClick={() => resume.mutate()}>
            {t('email.paused.resume')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export function EmailSuppressionsPanel() {
  const query = useEmailSuppressions();
  const [lifting, setLifting] = useState<EmailSuppression | null>(null);
  const blocked = query.data?.data ?? [];

  return (
    <Card data-testid="email-suppressions">
      <CardHeader
        title={t('email.suppressions.title')}
        description={t('email.suppressions.description')}
      />
      <CardBody>
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          query.error.status === 403 || query.error.status === 402 ? (
            <NoPermissionState
              compact
              title={t('email.settings.forbidden.title')}
              description={t('email.settings.forbidden.description')}
            />
          ) : (
            <ErrorState
              compact
              title={t('email.suppressions.error.title')}
              description={t('email.error.description')}
              action={
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )
        ) : blocked.length === 0 ? (
          <EmptyState
            compact
            icon={<MailIcon className="h-5 w-5" />}
            title={t('email.suppressions.empty.title')}
            description={t('email.suppressions.empty.description')}
          />
        ) : (
          <ul className="divide-y divide-border" data-testid="email-suppression-list">
            {blocked.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
                data-testid="email-suppression-row"
                data-reason={entry.reason}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {entry.address ?? t('email.suppressions.address.gone')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTime(entry.createdAt, DEFAULT_PREFERENCES)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="destructive">{t(`email.suppressions.reason.${entry.reason}`)}</Badge>
                  {entry.liftable ? (
                    <Button variant="outline" size="sm" onClick={() => setLifting(entry)}>
                      {t('email.suppressions.lift')}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t('email.suppressions.locked')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      {lifting !== null ? <LiftDialog entry={lifting} onClose={() => setLifting(null)} /> : null}
    </Card>
  );
}

function LiftDialog({ entry, onClose }: { entry: EmailSuppression; onClose: () => void }) {
  const lift = useLiftEmailSuppression();
  return (
    <Dialog
      title={t('email.suppressions.lift.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      data-testid="email-lift-dialog"
    >
      <p className="text-sm">
        {t('email.suppressions.lift.body', {
          address: entry.address ?? t('email.suppressions.address.gone'),
        })}
      </p>
      {lift.isError ? (
        <p role="alert" className="pt-2 text-sm text-destructive">
          {t('email.suppressions.lift.error')}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="ghost" onClick={onClose}>
          {t('field.cancel')}
        </Button>
        <Button
          loading={lift.isPending}
          onClick={() => lift.mutate(entry.id, { onSuccess: onClose })}
        >
          {t('email.suppressions.lift.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
