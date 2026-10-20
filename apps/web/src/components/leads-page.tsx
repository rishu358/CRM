'use client';

import {
  Button,
  EmptyState,
  ErrorState,
  LeadsIcon,
  NoResultsIcon,
  ListFooter,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  SearchField,
  TableSkeleton,
  Toolbar,
} from '@crm/ui';
import { useState } from 'react';
import { flattenLeadPages, useCreateLead, useLeadList } from '../lib/leads';
import { t } from '../lib/i18n';
import { useCreateShortcut } from '../lib/shortcuts';
import { AppShell } from './app-shell';
import { LeadsTable } from './leads-table';
import { ExportButton } from './export-button';
import { ImportLink } from './import-link';
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

  // `C` does what the New button does, on whichever list is on screen.
  useCreateShortcut(() => setCreating(true));

  const query = useLeadList(search);
  const create = useCreateLead();
  const leads = flattenLeadPages(query.data);

  const content = () => {
    if (query.isPending) return <TableSkeleton rows={8} columns={5} label={t('common.loading')} />;

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
          icon={<NoResultsIcon className="h-5 w-5" />}
          title={t('leads.noResults.title')}
          description={t('leads.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('common.clearSearch')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('leads.empty.title')}
          description={t('leads.empty.description')}
          icon={<LeadsIcon className="h-5 w-5" />}
          action={
            <>
              <Button onClick={() => setCreating(true)}>
                <PlusIcon className="h-4 w-4" />
                {t('leads.empty.action')}
              </Button>
              <ImportLink objectType="lead" />
            </>
          }
        />
      );
    }

    return (
      <div className="space-y-4">
        <LeadsTable leads={leads} />
        <ListFooter
          end={
            query.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('leads.loadMore')}
              </Button>
            ) : undefined
          }
        >
          {leads.length} {t('leads.count')}
        </ListFooter>
      </div>
    );
  };

  return (
    <AppShell>
      <PageHeader
        title={t('leads.title')}
        actions={
          <Button onClick={() => setCreating(true)} aria-keyshortcuts="C">
            <PlusIcon className="h-4 w-4" />
            {t('leads.new')}
          </Button>
        }
      />

      <Toolbar
        start={
          <SearchField
            id="lead-search"
            label={t('leads.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('leads.searchPlaceholder')}
            wrapperClassName="w-full sm:w-72"
          />
        }
        end={
          <>
            <ImportLink objectType="lead" />
            <ExportButton objectType="lead" q={search} sort="-created_at" />
          </>
        }
      />

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
