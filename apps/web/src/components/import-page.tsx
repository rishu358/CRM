'use client';

import { IMPORT_LIMITS } from '@crm/core';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckIcon,
  EmptyState,
  ErrorState,
  FileIcon,
  NoPermissionState,
  PageHeader,
  Select,
  Spinner,
  SuccessIcon,
  Table,
  TableCard,
  TableSkeleton,
  THead,
  Td,
  Th,
  Tr,
  WarningIcon,
  cn,
} from '@crm/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError } from '../lib/api-client';
import {
  useImportErrorFile,
  useImportJob,
  useRecentImports,
  useStartImport,
  useUploadImport,
  type ImportRecord,
} from '../lib/import-export';
import { t, type TranslationKey } from '../lib/i18n';
import { AppShell } from './app-shell';

/**
 * The import wizard (MVP_SPEC §M8).
 *
 *   choose a file  ->  upload  ->  checking  ->  map columns  ->  importing  ->  done
 *
 * The screen is a pure function of the job the server reports: it never decides
 * which step it is on, it reads `status`. That is what lets a user close the tab
 * mid-import, come back, pick the job from "recent imports", and land on the
 * right step — and what keeps the UI honest about work that happens in the
 * background rather than in this page.
 *
 * Nothing here is enforcement. The mapping screen offers only the fields the
 * server says this person may write (`targets`), but the API re-checks every
 * one on Start, the worker checks again at every chunk, and a column can never
 * be mapped onto an id or a version, nor onto an owner by somebody who may not
 * reassign records, because those are not offered and would be refused if
 * somebody sent them anyway.
 */

const MAX_MB = Math.round(IMPORT_LIMITS.maxUploadBytes / (1024 * 1024));

type ObjectType = 'contact' | 'account' | 'lead';
const OBJECTS: readonly { value: ObjectType; label: TranslationKey }[] = [
  { value: 'contact', label: 'import.object.contact' },
  { value: 'account', label: 'import.object.account' },
  { value: 'lead', label: 'import.object.lead' },
];

function isObjectType(value: string | null): value is ObjectType {
  return value === 'contact' || value === 'account' || value === 'lead';
}

/**
 * The four steps, as the person sees them. Which one is current is read off the
 * job's status — the same rule as the screen itself — so the indicator can
 * never say "step 2" over step 3.
 */
const STEPS: readonly TranslationKey[] = [
  'import.step.file',
  'import.step.map',
  'import.step.import',
  'import.step.done',
];

function stepOf(status: ImportRecord['status'] | null): number {
  switch (status) {
    case null:
    case 'awaiting_upload':
    case 'analyzing':
      return 0;
    case 'awaiting_mapping':
      return 1;
    case 'staging':
    case 'processing':
      return 2;
    case 'completed':
    case 'failed':
    case 'rejected':
      return 3;
  }
}

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label={t('import.steps')} className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className="flex items-center gap-2 text-sm"
          >
            <span
              aria-hidden="true"
              className={cn(
                'figures flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                done && 'bg-primary text-primary-foreground',
                active && 'bg-accent text-accent-foreground ring-2 ring-primary',
                !done && !active && 'bg-secondary text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className={cn(active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {t(label)}
            </span>
            {index < STEPS.length - 1 ? (
              <span aria-hidden="true" className="mx-1 hidden h-px w-6 bg-border sm:block" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ImportPage({ initialObject }: { initialObject: string | null }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useImportJob(jobId);

  const reset = () => setJobId(null);

  const body = () => {
    if (jobId === null) {
      return (
        <ChooseFile
          initialObject={isObjectType(initialObject) ? initialObject : 'contact'}
          onUploaded={(created) => setJobId(created.id)}
          onResume={setJobId}
        />
      );
    }

    if (job.isPending) return <TableSkeleton rows={4} columns={3} />;

    if (job.isError) {
      return job.error.status === 403 ? (
        <NoPermissionState
          title={t('import.forbidden.title')}
          description={t('import.forbidden.description')}
        />
      ) : (
        <ErrorState
          title={t('import.error.generic')}
          action={
            <Button variant="outline" onClick={() => void job.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    const record = job.data.data;
    switch (record.status) {
      case 'awaiting_upload':
      case 'analyzing':
        return (
          <Working title={t('import.analyzing')} description={t('import.analyzing.description')} />
        );
      case 'awaiting_mapping':
        return <MapColumns job={record} />;
      case 'staging':
      case 'processing':
        return <Running job={record} />;
      case 'completed':
        return <Finished job={record} onAgain={reset} />;
      case 'failed':
      case 'rejected':
        return <Stopped job={record} onAgain={reset} />;
    }
  };

  return (
    <AppShell>
      <PageHeader title={t('import.title')} description={t('import.subtitle')} />
      <div className="max-w-3xl">
        <Steps current={stepOf(jobId === null ? null : (job.data?.data.status ?? null))} />
        {body()}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Step 1: choose a file
// ---------------------------------------------------------------------------

function ChooseFile({
  initialObject,
  onUploaded,
  onResume,
}: {
  initialObject: ObjectType;
  onUploaded: (job: ImportRecord) => void;
  onResume: (id: string) => void;
}) {
  const [objectType, setObjectType] = useState<ObjectType>(initialObject);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useUploadImport();
  const recent = useRecentImports(true);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Cosmetic checks, for fast feedback. The server checks the declared size and
   * the worker checks the **bytes** (magic numbers, not the name): a file that
   * passes here is still untrusted.
   */
  const choose = (chosen: File | undefined) => {
    setProblem(null);
    if (chosen === undefined) {
      setFile(null);
      return;
    }
    if (!/\.(csv|xlsx)$/i.test(chosen.name)) {
      setFile(null);
      setProblem(t('import.file.invalid'));
    } else if (chosen.size === 0) {
      setFile(null);
      setProblem(t('import.file.empty'));
    } else if (chosen.size > IMPORT_LIMITS.maxUploadBytes) {
      setFile(null);
      setProblem(t('import.file.tooLarge', { size: MAX_MB }));
    } else {
      setFile(chosen);
    }
  };

  const submit = () => {
    if (file === null) {
      setProblem(t('import.file.missing'));
      return;
    }
    upload.mutate({ objectType, file }, { onSuccess: onUploaded });
  };

  if (upload.isPending && file !== null) {
    return (
      <Working
        title={t('import.uploading', { name: file.name })}
        description={t('import.uploading.description')}
      />
    );
  }

  const forbidden = upload.error instanceof ApiRequestError && upload.error.status === 403;
  const refused = upload.error instanceof ApiRequestError ? upload.error : null;

  return (
    <div className="space-y-8">
      <Card>
        <CardBody>
          <form
            className="space-y-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Select
              label={t('import.object')}
              value={objectType}
              onChange={(event) =>
                setObjectType(isObjectType(event.target.value) ? event.target.value : 'contact')
              }
            >
              {OBJECTS.map((object) => (
                <option key={object.value} value={object.value}>
                  {t(object.label)}
                </option>
              ))}
            </Select>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-file" className="text-sm font-medium">
                {t('import.file')}
              </label>
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-input bg-muted/40 p-4 transition-colors duration-fast hover:bg-accent/30">
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground"
                >
                  <FileIcon className="h-5 w-5" />
                </span>
                {/*
            `accept` is a hint to the picker, not a control: anyone can pick any
            file. The real check is on the bytes, in the worker.
          */}
                <input
                  ref={inputRef}
                  id="import-file"
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  aria-describedby="import-file-hint"
                  className="min-w-0 flex-1 cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground file:shadow-sm hover:file:bg-accent"
                  onChange={(event) => choose(event.target.files?.[0])}
                />
              </div>
              <p id="import-file-hint" className="text-xs text-muted-foreground">
                {t('import.file.hint', { size: MAX_MB })}
              </p>
            </div>

            {problem !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            ) : null}
            {forbidden ? (
              <p role="alert" className="text-sm text-destructive">
                {t('import.forbidden.description')}
              </p>
            ) : refused !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {refused.message}
              </p>
            ) : upload.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {upload.error.message}
              </p>
            ) : null}

            <Button type="submit" loading={upload.isPending}>
              {t('import.upload')}
            </Button>
          </form>
        </CardBody>
      </Card>

      {recent.data !== undefined && recent.data.data.length > 0 ? (
        <section aria-labelledby="recent-imports">
          <h2 id="recent-imports" className="mb-2 text-sm font-semibold">
            {t('import.recent')}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm">
            {recent.data.data.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{item.fileName}</span>
                <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                  {t(`import.status.${item.status}`)}
                  <Button variant="ghost" size="sm" onClick={() => onResume(item.id)}>
                    {t('import.recent.open')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Working({ title, description }: { title: string; description: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center rounded-lg border border-border bg-card p-10 text-center shadow-sm"
    >
      <Spinner className="mb-4 h-6 w-6 text-primary" />
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: map columns
// ---------------------------------------------------------------------------

/** "Last Name", "last_name" and "LASTNAME" are the same heading. */
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function MapColumns({ job }: { job: ImportRecord }) {
  const columns = job.columns ?? [];
  const targets = useMemo(() => job.targets ?? [], [job.targets]);
  const matchFields = job.matchFields ?? [];
  const start = useStartImport();

  // Suggest a mapping from the headings. A convenience only: the user sees and
  // can change every choice, and the server validates the result.
  const [choices, setChoices] = useState<Record<number, string>>(() => {
    const suggested: Record<number, string> = {};
    const used = new Set<string>();
    columns.forEach((heading, index) => {
      const key = normalize(heading);
      const match = targets.find(
        (target) =>
          !used.has(target.key) &&
          (normalize(target.label) === key || normalize(target.key) === key),
      );
      if (match !== undefined) {
        suggested[index] = match.key;
        used.add(match.key);
      }
    });
    return suggested;
  });
  const [mode, setMode] = useState<'skip' | 'update' | 'create'>('skip');
  const [matchField, setMatchField] = useState<string>(matchFields[0] ?? '');

  const mappedFields = new Set(Object.values(choices).filter((field) => field !== ''));
  const missing = targets.filter((target) => target.required && !mappedFields.has(target.key));
  const matchMapped = mode === 'create' || (matchField !== '' && mappedFields.has(matchField));
  const labelOf = (key: string) => targets.find((target) => target.key === key)?.label ?? key;

  // Never let the same field be chosen twice: the API refuses it, so the screen
  // should not offer it.
  const takenElsewhere = (column: number, key: string) =>
    Object.entries(choices).some(([other, field]) => Number(other) !== column && field === key);

  const submit = () => {
    start.mutate({
      id: job.id,
      mapping: Object.entries(choices)
        .filter(([, field]) => field !== '')
        .map(([column, field]) => ({ column: Number(column), field })),
      duplicateMode: mode,
      matchField: mode === 'create' ? null : matchField,
    });
  };

  const problem = start.error;
  const canStart = missing.length === 0 && matchMapped && mappedFields.size > 0;

  return (
    <form
      className="space-y-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (canStart) submit();
      }}
    >
      <Card>
        <section aria-labelledby="mapping-title">
          <CardHeader
            title={<span id="mapping-title">{t('import.mapping.title')}</span>}
            description={
              <>
                {t('import.mapping.description')}
                {job.totalRows !== null ? (
                  <span className="figures mt-1 block text-xs">
                    {t('import.mapping.rows', { count: job.totalRows })}
                  </span>
                ) : null}
              </>
            }
          />
          <CardBody className="space-y-4">
            <ul className="space-y-3">
              {columns.map((heading, index) => (
                <li key={index} className="grid items-end gap-3 sm:grid-cols-2">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">{heading}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {(job.preview ?? [])
                        .slice(0, 3)
                        .map((row) => row[index] ?? '')
                        .filter((cell) => cell !== '')
                        .join(' · ')}
                    </p>
                  </div>
                  <Select
                    label={`${t('import.mapping.skip')}: ${heading}`}
                    labelHidden
                    value={choices[index] ?? ''}
                    onChange={(event) =>
                      setChoices((current) => ({ ...current, [index]: event.target.value }))
                    }
                  >
                    <option value="">{t('import.mapping.skip')}</option>
                    {targets.map((target) => (
                      <option
                        key={target.key}
                        value={target.key}
                        disabled={takenElsewhere(index, target.key)}
                      >
                        {target.label}
                        {target.required ? ' *' : ''}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>

            {missing.length > 0 ? (
              <p role="status" className="text-sm font-medium text-destructive">
                {t('import.mapping.missing', {
                  fields: missing.map((target) => target.label).join(', '),
                })}
              </p>
            ) : null}
          </CardBody>
        </section>
      </Card>

      {(job.preview ?? []).length > 0 ? (
        <section aria-labelledby="preview-title">
          <h2 id="preview-title" className="mb-2 text-sm font-semibold">
            {t('import.mapping.preview')}
          </h2>
          <TableCard>
            <Table>
              <THead>
                <Tr className="hover:bg-transparent">
                  {columns.map((heading, index) => (
                    <Th key={index} className="h-auto py-2">
                      {heading}
                      {choices[index] !== undefined && choices[index] !== '' ? (
                        <span className="block text-xs font-normal text-primary">
                          {labelOf(choices[index] ?? '')}
                        </span>
                      ) : null}
                    </Th>
                  ))}
                </Tr>
              </THead>
              <tbody>
                {(job.preview ?? []).map((row, rowIndex) => (
                  <Tr key={rowIndex}>
                    {columns.map((_, index) => (
                      /* Rendered as text by React; never as markup. */
                      <Td key={index} className="max-w-[16rem] truncate">
                        {row[index] ?? ''}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableCard>
        </section>
      ) : null}

      <fieldset className="space-y-2.5">
        <legend className="mb-1 text-sm font-semibold">{t('import.duplicates.title')}</legend>
        {(['skip', 'update', 'create'] as const).map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-input bg-card p-3 text-sm transition-colors duration-fast hover:bg-accent/40 has-[:checked]:border-primary has-[:checked]:bg-accent/60"
          >
            <input
              type="radio"
              name="duplicate-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {t(`import.duplicates.${value}`)}
          </label>
        ))}

        {mode !== 'create' ? (
          <Select
            label={t('import.duplicates.matchBy')}
            hint={t('import.duplicates.matchBy.hint')}
            value={matchField}
            error={
              matchField !== '' && !mappedFields.has(matchField)
                ? t('import.duplicates.matchBy.unmapped')
                : undefined
            }
            onChange={(event) => setMatchField(event.target.value)}
          >
            {matchFields.map((key) => (
              <option key={key} value={key}>
                {labelOf(key)}
              </option>
            ))}
          </Select>
        ) : null}
      </fieldset>

      <p className="text-sm text-muted-foreground">{t('import.owner.note')}</p>
      {targets.some((target) => target.key === 'owner_id') ? (
        <p className="text-sm text-muted-foreground">{t('import.owner.offered')}</p>
      ) : null}

      {problem !== null ? (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{problem.message}</p>
          <ul className="list-disc pl-5">
            {problem.error.details.map((detail, index) => (
              <li key={index}>{detail.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button type="submit" loading={start.isPending} disabled={!canStart}>
        {t('import.start')}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Steps 3 and 4: running, then done
// ---------------------------------------------------------------------------

function Counts({ job }: { job: ImportRecord }) {
  const items = [
    ['import.counts.created', job.createdCount],
    ['import.counts.updated', job.updatedCount],
    ['import.counts.skipped', job.skippedCount],
    ['import.counts.failed', job.failedCount],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <dt className="text-xs text-muted-foreground">{t(label)}</dt>
          <dd className="figures mt-1 text-2xl font-semibold">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Running({ job }: { job: ImportRecord }) {
  const total = job.totalRows ?? 0;
  return (
    <div className="space-y-4" aria-live="polite">
      <div>
        <h2 className="text-base font-semibold">{t('import.running')}</h2>
        <p className="text-sm text-muted-foreground">{t('import.running.description')}</p>
      </div>
      <progress
        className="h-2 w-full overflow-hidden rounded-full"
        value={job.processedRows}
        max={Math.max(total, 1)}
        aria-label={t('import.running')}
      />
      <p className="figures text-sm">
        {t('import.progress', {
          processed: job.processedRows.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </p>
      <Counts job={job} />
    </div>
  );
}

function Finished({ job, onAgain }: { job: ImportRecord; onAgain: () => void }) {
  const errorFile = useImportErrorFile();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <div className="space-y-4">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-semibold focus-visible:ring-0"
      >
        <SuccessIcon aria-hidden="true" className="h-5 w-5 text-success" />
        {t('import.done.title')}
      </h2>
      <p className="text-sm">
        {t('import.done.description', {
          created: job.createdCount.toLocaleString(),
          updated: job.updatedCount.toLocaleString(),
          skipped: job.skippedCount.toLocaleString(),
          failed: job.failedCount.toLocaleString(),
        })}
      </p>
      <Counts job={job} />

      {job.hasErrorFile ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('import.errors.description')}</p>
          <Button
            variant="outline"
            loading={errorFile.isPending}
            onClick={() => errorFile.mutate(job.id)}
          >
            {t('import.errors.download')}
          </Button>
          {errorFile.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorFile.error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <Button onClick={onAgain}>{t('import.again')}</Button>
    </div>
  );
}

function Stopped({ job, onAgain }: { job: ImportRecord; onAgain: () => void }) {
  return (
    <EmptyState
      icon={<WarningIcon className="h-5 w-5" />}
      title={job.status === 'rejected' ? t('import.rejected.title') : t('import.failed.title')}
      {...(job.failureReason === null ? {} : { description: job.failureReason })}
      action={<Button onClick={onAgain}>{t('import.again')}</Button>}
    />
  );
}
