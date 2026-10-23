'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Input,
  NoPermissionState,
  PageHeader,
  Select,
  Skeleton,
} from '@crm/ui';
import { useState } from 'react';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import {
  useAuditLog,
  useArchive,
  useArchiveDownload,
  useRequestArchive,
  type AuditEntryView,
  type AuditFilters,
} from '../lib/governance';

/**
 * The audit log viewer (MVP_SPEC M11).
 *
 * Deliberately thin. Every rule that matters is on the server: who may open
 * this at all, which rows they may see, and — the one this module exists for —
 * **which fields of each diff they may see**. The diffs arrive already
 * filtered, so there is no client-side stripping here to forget. What the
 * screen does add is honesty about the filtering: when the server withheld
 * entries it says so, rather than showing a shorter diff as if that were the
 * whole change.
 *
 * All four states CLAUDE.md §9 requires are here, including the no-permission
 * one for a role without the audit capability. That state is cosmetic: the API
 * refused the request and this only explains the refusal.
 */
const OBJECT_FILTERS = [
  '',
  'account',
  'contact',
  'lead',
  'deal',
  'activity',
  'invitation',
  'user',
  'session',
] as const;

const ACTION_FILTERS = [
  '',
  'create',
  'update',
  'delete',
  'restore',
  'purge',
  'export',
  'import',
  'login',
  'logout',
  'erase',
  'redact',
] as const;

export function AuditLog() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [archiveId, setArchiveId] = useState<string | null>(null);

  const log = useAuditLog(filters);
  const requestArchive = useRequestArchive();
  const archive = useArchive(archiveId);
  const download = useArchiveDownload();

  const forbidden = log.error?.status === 403;
  const entries = log.data?.pages.flatMap((page) => page.data) ?? [];

  /**
   * Replace one filter.
   *
   * A key set to undefined is **removed** rather than carried as an explicit
   * undefined: the value becomes a query parameter, and `?from=undefined` is a
   * 422 rather than "no lower bound".
   */
  const update = (key: keyof AuditFilters, value: string | undefined) => {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const exportLog = async () => {
    const job = await requestArchive.mutateAsync({
      kind: 'audit_log',
      format: 'csv',
      filters,
    });
    setArchiveId(job.data.id);
  };

  const fetchLink = async () => {
    if (archiveId === null) return;
    const link = await download.mutateAsync(archiveId);
    globalThis.window.open(link.data.url, '_blank', 'noopener');
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('audit.title')} description={t('audit.description')} />

      <Card>
        {forbidden ? (
          <CardBody>
            <NoPermissionState
              title={t('audit.forbidden.title')}
              description={t('audit.forbidden.description')}
            />
          </CardBody>
        ) : (
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Select
                label={t('audit.filter.object')}
                value={filters.objectType ?? ''}
                onChange={(event) => update('objectType', event.target.value)}
              >
                {OBJECT_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {value === '' ? t('audit.filter.any') : value}
                  </option>
                ))}
              </Select>
              <Select
                label={t('audit.filter.action')}
                value={filters.action ?? ''}
                onChange={(event) => update('action', event.target.value)}
              >
                {ACTION_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {value === '' ? t('audit.filter.any') : value}
                  </option>
                ))}
              </Select>
              <Input
                label={t('audit.filter.from')}
                type="date"
                value={(filters.from ?? '').slice(0, 10)}
                onChange={(event) =>
                  update(
                    'from',
                    event.target.value === ''
                      ? undefined
                      : new Date(`${event.target.value}T00:00:00Z`).toISOString(),
                  )
                }
              />
              <Input
                label={t('audit.filter.to')}
                type="date"
                value={(filters.to ?? '').slice(0, 10)}
                onChange={(event) =>
                  update(
                    'to',
                    event.target.value === ''
                      ? undefined
                      : new Date(`${event.target.value}T23:59:59Z`).toISOString(),
                  )
                }
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => void exportLog()}
                disabled={requestArchive.isPending}
              >
                {t('audit.export')}
              </Button>
              {archive.data?.data.status === 'completed' ? (
                <Button type="button" variant="secondary" onClick={() => void fetchLink()}>
                  {t('audit.export.download')}
                </Button>
              ) : null}
              {archiveId !== null && archive.data?.data.status !== 'completed' ? (
                <span className="text-sm text-[var(--color-muted-foreground)]">
                  {archive.data?.data.status === 'failed'
                    ? t('audit.export.failed')
                    : t('audit.export.preparing')}
                </span>
              ) : null}
            </div>
          </CardBody>
        )}
      </Card>

      {forbidden ? null : log.isPending ? (
        <Card>
          <CardBody className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </CardBody>
        </Card>
      ) : log.isError ? (
        <Card>
          <CardBody>
            <ErrorState
              title={t('audit.error.title')}
              description={t('audit.error.description')}
              action={<Button onClick={() => void log.refetch()}>{t('action.retry')}</Button>}
            />
          </CardBody>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState title={t('audit.empty.title')} description={t('audit.empty.description')} />
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <ul className="divide-y divide-[var(--color-border)]">
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </ul>
            {log.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
              >
                {t('audit.loadMore')}
              </Button>
            ) : null}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntryView }) {
  const changed = Object.entries(entry.changes);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{entry.action}</Badge>
        <span className="text-sm font-medium">{entry.objectType}</span>
        <span className="text-sm text-[var(--color-muted-foreground)]">
          {entry.actorName ?? t('audit.actor.system')}
        </span>
        <span className="ml-auto text-xs text-[var(--color-muted-foreground)]">
          {formatDateTime(entry.occurredAt, DEFAULT_PREFERENCES)}
        </span>
      </div>

      {changed.length > 0 ? (
        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          {changed.map(([field, value]) => (
            <div key={field} className="flex gap-2">
              <dt className="text-[var(--color-muted-foreground)]">{field}</dt>
              <dd>
                {renderValue(value.old)} → {renderValue(value.new)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {entry.withheldFields > 0 ? (
        /* Said out loud: a diff the reader sees less of should not look complete. */
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {t('audit.withheld', { count: entry.withheldFields })}
        </p>
      ) : null}
    </li>
  );
}

function renderValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
