'use client';

import { Button, EmptyState, ErrorState, NoPermissionState, TableSkeleton } from '@crm/ui';
import { useState } from 'react';
import { flattenPages, useContactList, useCreateContact } from '../lib/contacts';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';
import { ContactsTable } from './contacts-table';
import { ExportButton } from './export-button';
import { ImportLink } from './import-link';
import { NewContactDialog } from './new-contact-dialog';

/**
 * The contacts list.
 *
 * Handles all four required states (CLAUDE.md §9): loading, empty, error and
 * no-permission. The no-permission branch is cosmetic — the API already
 * refused — but a bare error page would leave the user with nothing to do.
 */
export function ContactsPage() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const query = useContactList(search);
  const create = useCreateContact();
  const contacts = flattenPages(query.data);

  const content = () => {
    if (query.isPending) return <TableSkeleton rows={8} columns={5} />;

    if (query.isError) {
      if (query.error.status === 403) {
        return (
          <NoPermissionState
            title={t('contacts.forbidden.title')}
            description={t('contacts.forbidden.description')}
          />
        );
      }
      return (
        <ErrorState
          title={t('contacts.error.title')}
          description={t('contacts.error.description')}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    if (contacts.length === 0) {
      // An empty search result is a different situation from an empty database,
      // and offering "add your first contact" to someone who just mistyped a
      // name would be unhelpful.
      return search.length > 0 ? (
        <EmptyState
          title={t('contacts.noResults.title')}
          description={t('contacts.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('field.cancel')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('contacts.empty.title')}
          description={t('contacts.empty.description')}
          action={<Button onClick={() => setCreating(true)}>{t('contacts.empty.action')}</Button>}
        />
      );
    }

    return (
      <div className="space-y-4">
        <ContactsTable contacts={contacts} />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span aria-live="polite">
            {contacts.length} {t('contacts.count')}
          </span>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('contacts.loadMore')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <AppShell>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('contacts.title')}</h1>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="contact-search">
            {t('contacts.search')}
          </label>
          <input
            id="contact-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('contacts.searchPlaceholder')}
            className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
          />
          <ImportLink objectType="contact" />
          <ExportButton objectType="contact" q={search} sort="-created_at" />
          <Button onClick={() => setCreating(true)}>{t('contacts.new')}</Button>
        </div>
      </header>

      {content()}

      {creating ? (
        <NewContactDialog
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
