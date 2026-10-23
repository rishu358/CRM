'use client';

import {
  Button,
  EmptyState,
  ErrorState,
  AccountsIcon,
  NoResultsIcon,
  ListFooter,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  SearchField,
  TableSkeleton,
  Toolbar,
} from '@crm/ui';
import { useMemo, useState } from 'react';
import { flattenAccountPages, useAccountList, useCreateAccount } from '../lib/accounts';
import { t } from '../lib/i18n';
import { useCreateShortcut } from '../lib/shortcuts';
import { AppShell } from './app-shell';
import { ACCOUNT_COLUMNS, AccountsTable, DEFAULT_ACCOUNT_COLUMNS } from './accounts-table';
import { ColumnChooser } from './column-chooser';
import { customColumnOptions, useCustomColumns } from './custom-fields';
import { ExportButton } from './export-button';
import { ImportLink } from './import-link';
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
  const customColumns = useCustomColumns('account');
  const [sort, setSort] = useState('-created_at');
  const [visibleColumns, setVisibleColumns] = useState<string[]>([...DEFAULT_ACCOUNT_COLUMNS]);
  const [creating, setCreating] = useState(false);

  // `C` does what the New button does, on whichever list is on screen.
  useCreateShortcut(() => setCreating(true));

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
    if (query.isPending) return <TableSkeleton rows={8} columns={5} label={t('common.loading')} />;

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
          description={
            query.error.code === 'SEARCH_TIMEOUT'
              ? t('list.searchTooBroad')
              : t('accounts.error.description')
          }
          action={
            query.error.code === 'SEARCH_TIMEOUT' ? (
              <Button variant="outline" onClick={() => setSearch('')}>
                {t('common.clearSearch')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            )
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
          icon={<NoResultsIcon className="h-5 w-5" />}
          title={t('accounts.noResults.title')}
          description={t('accounts.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('common.clearSearch')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.description')}
          icon={<AccountsIcon className="h-5 w-5" />}
          action={
            <>
              <Button onClick={() => setCreating(true)}>
                <PlusIcon className="h-4 w-4" />
                {t('accounts.empty.action')}
              </Button>
              <ImportLink objectType="account" />
            </>
          }
        />
      );
    }

    return (
      <div className="space-y-4">
        <AccountsTable
          accounts={accounts}
          visibleColumns={visibleColumns}
          customFields={customColumns.definitions}
          sort={sort}
          onSortChange={setSort}
        />
        <ListFooter
          end={
            query.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('accounts.loadMore')}
              </Button>
            ) : undefined
          }
        >
          {accounts.length} {t('accounts.count')}
          {(query.data?.pages ?? []).some((page) => page.meta.truncated === true)
            ? ` · ${t('list.truncated')}`
            : ''}
        </ListFooter>
      </div>
    );
  };

  return (
    <AppShell>
      <PageHeader
        title={t('accounts.title')}
        actions={
          <Button onClick={() => setCreating(true)} aria-keyshortcuts="C">
            <PlusIcon className="h-4 w-4" />
            {t('accounts.new')}
          </Button>
        }
      />

      <Toolbar
        start={
          <SearchField
            id="account-search"
            label={t('accounts.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('accounts.searchPlaceholder')}
            wrapperClassName="w-full sm:w-72"
          />
        }
        end={
          <>
            {choosableColumns.length > 0 ? (
              <ColumnChooser
                options={[...choosableColumns, ...customColumnOptions(customColumns.definitions)]}
                selected={visibleColumns}
                onChange={setVisibleColumns}
              />
            ) : null}
            <ImportLink objectType="account" />
            <ExportButton objectType="account" q={search} sort={sort} />
          </>
        }
      />

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
