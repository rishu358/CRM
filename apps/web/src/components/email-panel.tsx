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
  PlusIcon,
  Skeleton,
} from '@crm/ui';
import { useState } from 'react';
import {
  failureKey,
  useRecordEmails,
  useRetryEmail,
  type EmailMessage,
  type EmailSourceType,
} from '../lib/emails';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import { SendEmailDialog } from './send-email-dialog';

/**
 * The emails sent from or about one record (ADR-0073), beside its activities on every record page.
 *
 * Whoever may read the record sees the whole team's emails on it, with where each got to. "Sent"
 * means the mail service accepted the message, not that it arrived, and a tooltip on the badge says
 * so. The four states are all here: loading, empty (with the action that fills it), an error, and
 * no permission (a 403 is "you may not read these", never "there are none").
 */
export function EmailPanel({
  objectType,
  recordId,
  people,
}: {
  objectType: EmailSourceType;
  recordId: string;
  /** For a deal: the contacts it can be written to, the main one first. */
  people?: readonly string[];
}) {
  const query = useRecordEmails(objectType, recordId);
  const [composing, setComposing] = useState(false);

  const emails = query.data?.data ?? [];
  const blocked = query.isError && (query.error.status === 403 || query.error.status === 402);

  return (
    <Card data-testid="email-panel">
      <CardHeader
        title={t('email.card.title')}
        actions={
          blocked ? null : (
            <Button size="sm" onClick={() => setComposing(true)} data-testid="email-send">
              <PlusIcon className="h-4 w-4" />
              {t('email.send')}
            </Button>
          )
        }
      />
      <CardBody>
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : query.isError ? (
          query.error.status === 403 ? (
            <NoPermissionState
              compact
              title={t('email.forbidden.title')}
              description={t('email.forbidden.description')}
            />
          ) : query.error.status === 402 ? (
            <NoPermissionState
              compact
              title={t('email.disabled.title')}
              description={t('email.disabled.description')}
            />
          ) : (
            <ErrorState
              compact
              title={t('email.error.title')}
              description={t('email.error.description')}
              action={
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )
        ) : emails.length === 0 ? (
          <EmptyState
            compact
            icon={<MailIcon className="h-5 w-5" />}
            title={t('email.empty.title')}
            description={t('email.empty.description')}
            action={
              <Button size="sm" onClick={() => setComposing(true)}>
                {t('email.empty.action')}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border" data-testid="email-list">
            {emails.map((email) => (
              <EmailRow key={email.id} email={email} />
            ))}
          </ul>
        )}
      </CardBody>

      {composing ? (
        <SendEmailDialog
          objectType={objectType}
          recordId={recordId}
          {...(people === undefined ? {} : { people })}
          onClose={() => setComposing(false)}
        />
      ) : null}
    </Card>
  );
}

function statusTone(status: EmailMessage['status']) {
  switch (status) {
    case 'sent':
    case 'delivered':
      return 'success' as const;
    case 'failed':
    case 'bounced':
    case 'complained':
      return 'destructive' as const;
    case 'queued':
    case 'sending':
      return 'neutral' as const;
  }
}

function EmailRow({ email }: { email: EmailMessage }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const retry = useRetryEmail();
  const failed = email.status === 'failed';
  const canRetry = failed && email.retriedById === null && !email.erased;

  const doRetry = () => {
    retry.mutate(email.id, { onSuccess: () => setConfirming(false) });
  };

  return (
    <li className="py-3" data-testid="email-row" data-status={email.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{email.erased ? t('email.row.erased') : email.subject}</span>
        <span title={email.status === 'sent' ? t('email.status.sent.hint') : undefined}>
          <Badge tone={statusTone(email.status)}>{t(`email.status.${email.status}`)}</Badge>
        </span>
        {email.retriedById !== null ? <Badge tone="neutral">{t('email.row.retried')}</Badge> : null}
      </div>

      <p className="mt-0.5 text-sm text-muted-foreground">
        {email.toAddress === null ? null : `${t('email.row.to', { address: email.toAddress })} · `}
        {email.sentByName === null ? null : `${t('email.row.by', { name: email.sentByName })} · `}
        {formatDateTime(email.sentAt ?? email.queuedAt, DEFAULT_PREFERENCES)}
      </p>

      {failed ? (
        <p className="mt-1 text-sm text-destructive" data-testid="email-failure">
          {t(failureKey(email.failureCode))}
        </p>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-2">
        {email.erased ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('email.row.hide') : t('email.row.show')}
          </Button>
        )}
        {canRetry ? (
          <Button
            variant="outline"
            size="sm"
            loading={retry.isPending}
            onClick={() =>
              email.failureCode === 'outcome_unknown' ? setConfirming(true) : doRetry()
            }
          >
            {t('email.row.retry')}
          </Button>
        ) : null}
      </div>

      {retry.isError && !confirming ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {t('email.row.retry.error')}
        </p>
      ) : null}

      {open && !email.erased ? (
        // Plain text, shown as text: nothing in a message is ever rendered as markup (ADR-0073).
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-sans text-sm">
          {email.body}
        </pre>
      ) : null}

      {confirming ? (
        <Dialog
          title={t('email.row.retry.unknown.title')}
          closeLabel={t('common.close')}
          onClose={() => setConfirming(false)}
        >
          <p className="text-sm">{t('email.row.retry.unknown.body')}</p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('field.cancel')}
            </Button>
            <Button loading={retry.isPending} onClick={doRetry}>
              {t('email.row.retry.confirm')}
            </Button>
          </div>
          {retry.isError ? (
            <p role="alert" className="pt-2 text-sm text-destructive">
              {t('email.row.retry.error')}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </li>
  );
}
