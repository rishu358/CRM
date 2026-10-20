'use client';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  NoPermissionState,
  Skeleton,
  cn,
} from '@crm/ui';
import { useState } from 'react';
import { DEFAULT_PREFERENCES, formatDate } from '../lib/format';
import { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import {
  useRecycleBin,
  useRestoreRecord,
  type RecycleBinEntryView,
} from '../lib/governance';

/**
 * The Recycle Bin (MVP_SPEC M4).
 *
 * One object type at a time, as tabs, which is the API's shape and not a UI
 * choice: a single merged list cannot be keyset-paged across five independently
 * indexed tables without losing the property the cursor exists to give
 * (ADR-0012).
 *
 * Restoring is a real write with a `version`, so a record that moved since the
 * list was fetched produces a conflict rather than a silent overwrite — the same
 * rule as inline editing.
 */
const TABS = ['contact', 'account', 'lead', 'deal', 'activity'] as const;

const TAB_LABEL: Readonly<Record<(typeof TABS)[number], Parameters<typeof t>[0]>> = {
  contact: 'nav.contacts',
  account: 'nav.accounts',
  lead: 'nav.leads',
  deal: 'nav.deals',
  activity: 'nav.myDay',
};

export function RecycleBin() {
  const [objectType, setObjectType] = useState<(typeof TABS)[number]>('contact');
  const [error, setError] = useState<string | null>(null);

  const bin = useRecycleBin(objectType);
  const restore = useRestoreRecord(objectType);

  const forbidden = bin.error?.status === 403;
  const entries = bin.data?.pages.flatMap((page) => page.data) ?? [];

  const putBack = async (entry: RecycleBinEntryView) => {
    setError(null);
    try {
      await restore.mutateAsync(entry);
    } catch (thrown) {
      // Branch on the code, never the message (CLAUDE.md §8) — and on the error
      // that was thrown, not `restore.error`, which is the previous render's.
      const code = thrown instanceof ApiRequestError ? thrown.code : undefined;
      setError(
        code === 'VERSION_CONFLICT'
          ? t('recycleBin.conflict')
          : code === 'FORBIDDEN'
            ? t('recycleBin.notAllowed')
            : t('error.generic'),
      );
    }
  };

  return (
    <Card>
      <CardHeader title={t('recycleBin.title')} description={t('recycleBin.description')} />

      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-2" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === objectType}
              onClick={() => {
                setObjectType(tab);
                setError(null);
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm',
                tab === objectType
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'text-[var(--color-muted-foreground)]',
              )}
            >
              {t(TAB_LABEL[tab])}
            </button>
          ))}
        </div>

        {error === null ? null : (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            {error}
          </p>
        )}

        {forbidden ? (
          <NoPermissionState
            title={t('recycleBin.forbidden.title')}
            description={t('recycleBin.forbidden.description')}
          />
        ) : bin.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : bin.isError ? (
          <ErrorState
            title={t('recycleBin.error.title')}
            description={t('recycleBin.error.description')}
            action={<Button onClick={() => void bin.refetch()}>{t('action.retry')}</Button>}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            title={t('recycleBin.empty.title')}
            description={t('recycleBin.empty.description')}
          />
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-border)]">
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-sm text-[var(--color-muted-foreground)]">
                    {t('recycleBin.deletedOn', {
                      date: formatDate(entry.deletedAt, DEFAULT_PREFERENCES),
                    })}
                  </span>
                  <span className="text-sm text-[var(--color-muted-foreground)]">
                    {t('recycleBin.purgeOn', {
                      date: formatDate(entry.purgeAfter, DEFAULT_PREFERENCES),
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    className="ml-auto"
                    onClick={() => void putBack(entry)}
                    disabled={restore.isPending}
                  >
                    {t('recycleBin.restore')}
                  </Button>
                </li>
              ))}
            </ul>
            {bin.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void bin.fetchNextPage()}
                disabled={bin.isFetchingNextPage}
              >
                {t('recycleBin.loadMore')}
              </Button>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
