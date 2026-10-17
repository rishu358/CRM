'use client';

import { Button, EmptyState, ErrorState, NoPermissionState, TableSkeleton } from '@crm/ui';
import { useMemo, useState } from 'react';
import { flattenAccountPages, useAccountList, useCreateAccount } from '../lib/accounts';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';
import { ACCOUNT_COLUMNS, AccountsTable, DEFAULT_ACCOUNT_COLUMNS } from './accounts-table';
import { ColumnChooser } from './column-chooser';
import { NewAccountDialog } from './new-account-dialog';

/**
 * The accounts list.
 *
 * Handles all four required states (CLAUDE.md §9): loading, empty, error and
 * no-permission. The no-permission branch is cosmetic — the API already
 * refused — but a bare error page would leave the user with nothing to do.
 */
export function AccountsPage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('-created_at');
  const [visibleColumns, setVisibleColumns] = useState<string[]>([...DEFAULT_ACCOUNT_COLUMNS]);
  const [creating, setCreating] = useState(false);

  const query = useAccountList(search, sort);
  const create = useCreateAccount();
  const accounts = flattenAccountPages(query.data);

  /**
   * Only offer a column the API actually sent.
   *
   * A field the signed-in user may not read is absent from every row, so
   * offering it in the chooser would name a field they are not allowed to
   * know exists (CLAUDE.md §5.4).
   */
  const choosableColumns = useMemo(() => {
    const present = new Set<string>();
    for (const account of accounts) {
      for (const key of Object.keys(account)) present.add(key);
    }
    return ACCOUNT_COLUMNS.filter((column) => present.has(column.key));
  }, [accounts]);

  const content = () => {
    if (query.isPending) return <TableSkeleton rows={8} columns={5} />;

    if (query.isError) {
      if (query.error.status === 403) {
        return (
          <NoPermissionState
            title={t('accounts.forbidden.title')}
            description={t('accounts.forbidden.description')}
          />
        );
      }
      return (
        <ErrorState
          title={t('accounts.error.title')}
          description={t('accounts.error.description')}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    if (accounts.length === 0) {
      // An empty search result is a different situation from an empty
      // database, and offering "add your first account" to someone who just
      // mistyped a name would be unhelpful.
      return search.length > 0 ? (
        <EmptyState
          title={t('accounts.noResults.title')}
          description={t('accounts.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('field.cancel')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.description')}
          action={<Button onClick={() => setCreating(true)}>{t('accounts.empty.action')}</Button>}
        />
      );
    }

    return (
      <div className="space-y-4">
        <AccountsTable
          accounts={accounts}
          visibleColumns={visibleColumns}
          sort={sort}
          onSortChange={setSort}
        />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span aria-live="polite">
            {accounts.length} {t('accounts.count')}
          </span>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('accounts.loadMore')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <AppShell>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('accounts.title')}</h1>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="account-search">
            {t('accounts.search')}
          </label>
          <input
            id="account-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('accounts.searchPlaceholder')}
            className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
          />
          {choosableColumns.length > 0 ? (
            <ColumnChooser
              options={choosableColumns}
              selected={visibleColumns}
              onChange={setVisibleColumns}
            />
          ) : null}
          <Button onClick={() => setCreating(true)}>{t('accounts.new')}</Button>
        </div>
      </header>

      {content()}

      {creating ? (
        <NewAccountDialog
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
