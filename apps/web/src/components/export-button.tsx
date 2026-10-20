'use client';

import { Button, Dialog, DialogFooter, ExportIcon, Select } from '@crm/ui';
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
        <ExportIcon className="h-4 w-4" />
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

  // Focus moves to the first control on open; the dialog itself traps focus and
  // closes on Escape (CLAUDE.md §9).
  useEffect(() => {
    selectRef.current?.focus();
  }, []);

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
    <Dialog
      title={t('export.title', { objects: t(OBJECT_LABELS[objectType]) })}
      description={t('export.description')}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
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

      <DialogFooter>
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
      </DialogFooter>
    </Dialog>
  );
}
