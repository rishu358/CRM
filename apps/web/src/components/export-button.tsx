'use client';

import { Button, Select } from '@crm/ui';
import { useEffect, useRef, useState } from 'react';
import {
  useCreateExport,
  useExportDownload,
  useExportJob,
  type ExportRequest,
} from '../lib/import-export';
import { t } from '../lib/i18n';

/**
 * Export what the list is showing (MVP_SPEC §M8).
 *
 * The request carries the list's own search, sort and filters, so the file has
 * the rows the screen has — and the API refuses a filter the caller could not
 * have used on the list, so this cannot be a way to ask a question the list
 * would not answer (CLAUDE.md §5.4).
 *
 * What it deliberately does **not** send is a column list. Which columns an
 * export has is decided on the server from field metadata and the caller's
 * field permissions; a hidden field is not an empty column, it is no column.
 *
 * The file is built in the background and arrives as a short-lived link to the
 * object store. Nothing is streamed through this app.
 */
export function ExportButton({
  objectType,
  filter,
  sort,
  q,
}: {
  objectType: ExportRequest['objectType'];
  filter?: readonly string[] | undefined;
  sort?: string | undefined;
  q?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <>
      <Button ref={buttonRef} variant="outline" onClick={() => setOpen(true)}>
        {t('export.button')}
      </Button>
      {open ? (
        <ExportDialog objectType={objectType} filter={filter} sort={sort} q={q} onClose={close} />
      ) : null}
    </>
  );
}

const OBJECT_LABELS = {
  contact: 'export.object.contact',
  account: 'export.object.account',
  lead: 'export.object.lead',
  deal: 'export.object.deal',
} as const;

function ExportDialog({
  objectType,
  filter,
  sort,
  q,
  onClose,
}: {
  objectType: ExportRequest['objectType'];
  filter: readonly string[] | undefined;
  sort: string | undefined;
  q: string | undefined;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [jobId, setJobId] = useState<string | null>(null);

  const create = useCreateExport();
  const job = useExportJob(jobId);
  const download = useExportDownload();
  const selectRef = useRef<HTMLSelectElement>(null);

  // Focus moves into the dialog on open and Escape closes it (CLAUDE.md §9).
  useEffect(() => {
    selectRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const record = job.data?.data;
  const forbidden =
    (create.error?.status === 403 || job.error?.status === 403 || download.error?.status === 403) ??
    false;
  const failed = record?.status === 'failed' || (create.isError && !forbidden);
  const running = create.isPending || record?.status === 'queued' || record?.status === 'running';

  const start = () => {
    create.mutate(
      { objectType, format, filter, sort, q },
      { onSuccess: (created) => setJobId(created.id) },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 id="export-title" className="mb-2 text-base font-semibold">
          {t('export.title', { objects: t(OBJECT_LABELS[objectType]) })}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">{t('export.description')}</p>

        {record === undefined && !running ? (
          <Select
            ref={selectRef}
            label={t('export.format')}
            value={format}
            onChange={(event) => setFormat(event.target.value === 'xlsx' ? 'xlsx' : 'csv')}
          >
            <option value="csv">{t('export.format.csv')}</option>
            <option value="xlsx">{t('export.format.xlsx')}</option>
          </Select>
        ) : null}

        <div aria-live="polite" className="mt-4 space-y-3 text-sm">
          {running ? <p>{t('export.running')}</p> : null}

          {record?.status === 'completed' ? (
            <>
              <p>{t('export.ready', { count: record.rowCount ?? 0 })}</p>
              <p className="text-muted-foreground">{t('export.expires')}</p>
            </>
          ) : null}

          {forbidden ? (
            <p role="alert" className="text-destructive">
              {t('export.forbidden')}
            </p>
          ) : failed ? (
            <p role="alert" className="text-destructive">
              {record?.failureReason ?? create.error?.message ?? t('export.failed')}
            </p>
          ) : null}
          {download.isError && !forbidden ? (
            <p role="alert" className="text-destructive">
              {t('export.error')}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('export.close')}
          </Button>
          {record?.status === 'completed' ? (
            <Button loading={download.isPending} onClick={() => download.mutate(record.id)}>
              {t('export.download')}
            </Button>
          ) : record === undefined || failed || forbidden ? (
            <Button loading={create.isPending} disabled={running} onClick={start}>
              {t('export.start')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
