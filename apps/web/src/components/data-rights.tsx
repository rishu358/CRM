'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  NoPermissionState,
  Select,
  Skeleton,
} from '@crm/ui';
import { useState, type FormEvent } from 'react';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import {
  useArchive,
  useArchiveDownload,
  useErasureRequests,
  useRequestArchive,
  useRequestErasure,
} from '../lib/governance';

/**
 * Data rights (MVP_SPEC M11): DPDP and GDPR.
 *
 * Three things an administrator does here — take the whole workspace away as an
 * archive, answer one person's "send me my data", and erase a person — and the
 * screen's job for the third is to make it clear what is about to happen.
 * Erasure is irreversible, reaches into the append-only audit log, and the
 * server only lets the Owner ask for it; the UI says so and asks twice.
 *
 * Each card shows a no-permission state on its own, because the capabilities are
 * separate: an Admin may answer a subject request but may not download the
 * company or erase anybody.
 */
export function DataRights() {
  return (
    <div className="space-y-4">
      <TenantArchiveCard />
      <SubjectArchiveCard />
      <ErasureCard />
    </div>
  );
}

/** Reusable: queue an archive, watch it, then fetch a short-lived link. */
function useArchiveFlow() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const request = useRequestArchive();
  const job = useArchive(jobId);
  const download = useArchiveDownload();

  const start = async (input: Parameters<typeof request.mutateAsync>[0]) => {
    setForbidden(false);
    try {
      const created = await request.mutateAsync(input);
      setJobId(created.data.id);
    } catch (error) {
      // Read the error that was **thrown**. `request.error` is the hook's value
      // from the render this handler closed over, so inside a catch it is still
      // empty and a refusal would never reach the screen.
      if (error instanceof ApiRequestError && error.status === 403) setForbidden(true);
    }
  };

  const open = async () => {
    if (jobId === null) return;
    const link = await download.mutateAsync(jobId);
    globalThis.window.open(link.data.url, '_blank', 'noopener');
  };

  return { jobId, job, start, open, forbidden, pending: request.isPending };
}

function ArchiveStatus({
  status,
  onDownload,
}: {
  status: 'queued' | 'running' | 'completed' | 'failed' | undefined;
  onDownload: () => void;
}) {
  if (status === undefined) return null;
  if (status === 'completed') {
    return (
      <Button type="button" variant="secondary" onClick={onDownload}>
        {t('dataRights.download')}
      </Button>
    );
  }
  return (
    <span className="text-sm text-[var(--color-muted-foreground)]">
      {status === 'failed' ? t('dataRights.failed') : t('dataRights.preparing')}
    </span>
  );
}

function TenantArchiveCard() {
  const flow = useArchiveFlow();

  return (
    <Card>
      <CardHeader title={t('dataRights.tenant.title')} description={t('dataRights.tenant.description')} />
      <CardBody className="flex flex-wrap items-center gap-3">
        {flow.forbidden ? (
          <NoPermissionState
            title={t('dataRights.tenant.forbidden.title')}
            description={t('dataRights.tenant.forbidden.description')}
          />
        ) : (
          <>
            <Button
              type="button"
              onClick={() => void flow.start({ kind: 'tenant', format: 'json' })}
              disabled={flow.pending}
            >
              {t('dataRights.tenant.action')}
            </Button>
            <ArchiveStatus status={flow.job.data?.data.status} onDownload={() => void flow.open()} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SubjectArchiveCard() {
  const flow = useArchiveFlow();
  const [objectType, setObjectType] = useState<'contact' | 'lead'>('contact');
  const [recordId, setRecordId] = useState('');
  const [notFound, setNotFound] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotFound(false);
    await flow.start({ kind: 'data_subject', format: 'json', subject: { objectType, recordId } });
  };

  return (
    <Card>
      <CardHeader title={t('dataRights.subject.title')} description={t('dataRights.subject.description')} />
      <CardBody>
        {flow.forbidden ? (
          <NoPermissionState
            title={t('dataRights.subject.forbidden.title')}
            description={t('dataRights.subject.forbidden.description')}
          />
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('dataRights.subject.type')}
                value={objectType}
                onChange={(event) => setObjectType(event.target.value as 'contact' | 'lead')}
              >
                <option value="contact">{t('nav.contacts')}</option>
                <option value="lead">{t('nav.leads')}</option>
              </Select>
              <Input
                label={t('dataRights.subject.recordId')}
                value={recordId}
                onChange={(event) => setRecordId(event.target.value)}
                required
              />
            </div>
            {notFound ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {t('dataRights.subject.notFound')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={flow.pending}>
                {t('dataRights.subject.action')}
              </Button>
              <ArchiveStatus
                status={flow.job.data?.data.status}
                onDownload={() => void flow.open()}
              />
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function ErasureCard() {
  const requests = useErasureRequests();
  const erase = useRequestErasure();

  const [objectType, setObjectType] = useState<'contact' | 'lead'>('contact');
  const [recordId, setRecordId] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forbidden = requests.error?.status === 403;
  const rows = requests.data?.data ?? [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    // Asked twice, deliberately. This cannot be undone, and the second click is
    // the cheapest safeguard there is.
    if (!confirming) {
      setConfirming(true);
      return;
    }

    try {
      await erase.mutateAsync({
        subjectObjectType: objectType,
        subjectRecordId: recordId,
        ...(reason.length > 0 ? { reason } : {}),
      });
      setRecordId('');
      setReason('');
      setConfirming(false);
    } catch (thrown) {
      // The thrown error, not `erase.error` — see `useArchiveFlow`.
      const code = thrown instanceof ApiRequestError ? thrown.code : undefined;
      setError(
        code === 'CONFLICT'
          ? t('dataRights.erase.inProgress')
          : code === 'NOT_FOUND'
            ? t('dataRights.erase.notFound')
            : code === 'FORBIDDEN'
              ? t('dataRights.erase.notAllowed')
              : t('error.generic'),
      );
      setConfirming(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t('dataRights.erase.title')} description={t('dataRights.erase.description')} />
      <CardBody className="space-y-4">
        {forbidden ? (
          <NoPermissionState
            title={t('dataRights.erase.forbidden.title')}
            description={t('dataRights.erase.forbidden.description')}
          />
        ) : (
          <>
            <form onSubmit={(event) => void submit(event)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Select
                  label={t('dataRights.subject.type')}
                  value={objectType}
                  onChange={(event) => {
                    setObjectType(event.target.value as 'contact' | 'lead');
                    setConfirming(false);
                  }}
                >
                  <option value="contact">{t('nav.contacts')}</option>
                  <option value="lead">{t('nav.leads')}</option>
                </Select>
                <Input
                  label={t('dataRights.subject.recordId')}
                  value={recordId}
                  onChange={(event) => {
                    setRecordId(event.target.value);
                    setConfirming(false);
                  }}
                  required
                />
                <Input
                  label={t('dataRights.erase.reason')}
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>

              {error === null ? null : (
                <p role="alert" className="text-sm text-[var(--color-destructive)]">
                  {error}
                </p>
              )}

              {confirming ? (
                <p role="alert" className="text-sm font-medium">
                  {t('dataRights.erase.confirm')}
                </p>
              ) : null}

              <Button type="submit" variant={confirming ? 'destructive' : 'secondary'} disabled={erase.isPending}>
                {confirming ? t('dataRights.erase.confirmAction') : t('dataRights.erase.action')}
              </Button>
            </form>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('dataRights.erase.history')}</h3>
              {requests.isPending ? (
                <Skeleton className="h-10 w-full" />
              ) : requests.isError ? (
                <ErrorState
                  title={t('dataRights.erase.error.title')}
                  description={t('dataRights.erase.error.description')}
                  action={
                    <Button onClick={() => void requests.refetch()}>{t('action.retry')}</Button>
                  }
                />
              ) : rows.length === 0 ? (
                <EmptyState
                  title={t('dataRights.erase.empty.title')}
                  description={t('dataRights.erase.empty.description')}
                />
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <Badge>{row.status}</Badge>
                      <span>{row.subjectObjectType}</span>
                      <span className="text-[var(--color-muted-foreground)]">
                        {row.subjectRecordId}
                      </span>
                      <span className="text-[var(--color-muted-foreground)]">
                        {t('dataRights.erase.counts', {
                          records: row.recordsErased,
                          auditRows: row.auditRowsRedacted,
                        })}
                      </span>
                      <span className="ml-auto text-xs text-[var(--color-muted-foreground)]">
                        {formatDateTime(row.createdAt, DEFAULT_PREFERENCES)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardBody>
    </Card>
  );
}
