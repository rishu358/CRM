'use client';

import { Button, EmptyState, ErrorState, NoPermissionState, TableSkeleton } from '@crm/ui';
import { useState } from 'react';
import { flattenLeadPages, useCreateLead, useLeadList } from '../lib/leads';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';
import { LeadsTable } from './leads-table';
import { NewLeadDialog } from './new-lead-dialog';

/**
 * The leads list.
 *
 * Handles all four required states (CLAUDE.md §9): loading, empty, error and
 * no-permission. The no-permission branch is cosmetic — the API already
 * refused — but a bare error page would leave the user with nothing to do.
 */
export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const query = useLeadList(search);
  const create = useCreateLead();
  const leads = flattenLeadPages(query.data);

  const content = () => {
    if (query.isPending) return <TableSkeleton rows={8} columns={5} />;

    if (query.isError) {
      if (query.error.status === 403) {
        return (
          <NoPermissionState
            title={t('leads.forbidden.title')}
            description={t('leads.forbidden.description')}
          />
        );
      }
      return (
        <ErrorState
          title={t('leads.error.title')}
          description={t('leads.error.description')}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    if (leads.length === 0) {
      // An empty search result is a different situation from an empty database,
      // and offering "add your first lead" to someone who just mistyped a
      // name would be unhelpful.
      return search.length > 0 ? (
        <EmptyState
          title={t('leads.noResults.title')}
          description={t('leads.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('field.cancel')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('leads.empty.title')}
          description={t('leads.empty.description')}
          action={<Button onClick={() => setCreating(true)}>{t('leads.empty.action')}</Button>}
        />
      );
    }

    return (
      <div className="space-y-4">
        <LeadsTable leads={leads} />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span aria-live="polite">
            {leads.length} {t('leads.count')}
          </span>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('leads.loadMore')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <AppShell>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('leads.title')}</h1>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="lead-search">
            {t('leads.search')}
          </label>
          <input
            id="lead-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('leads.searchPlaceholder')}
            className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
          />
          <Button onClick={() => setCreating(true)}>{t('leads.new')}</Button>
        </div>
      </header>

      {content()}

      {creating ? (
        <NewLeadDialog
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            setCreating(false);
            create.reset();
          }}
          onSubmit={(values) => {
            create.mutate(values, { onSuccess: () => setCreating(false) });
          }}
        />
      ) : null}
    </AppShell>
  );
}
