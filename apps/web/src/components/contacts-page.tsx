'use client';

import {
  Button,
  EmptyState,
  ErrorState,
  ContactsIcon,
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
import { flattenPages, useContactList, useCreateContact } from '../lib/contacts';
import { t } from '../lib/i18n';
import { useCreateShortcut } from '../lib/shortcuts';
import { AppShell } from './app-shell';
import { ContactsTable } from './contacts-table';
import { CustomColumnsChooser, useCustomColumns } from './custom-fields';
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
  const customColumns = useCustomColumns('contact');
  const [creating, setCreating] = useState(false);

  // `C` does what the New button does, on whichever list is on screen.
  useCreateShortcut(() => setCreating(true));

  const query = useContactList(search);
  const create = useCreateContact();
  const contacts = flattenPages(query.data);

  const content = () => {
    if (query.isPending) return <TableSkeleton rows={8} columns={5} label={t('common.loading')} />;

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
          description={
            query.error.code === 'SEARCH_TIMEOUT'
              ? t('list.searchTooBroad')
              : t('contacts.error.description')
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

    if (contacts.length === 0) {
      // An empty search result is a different situation from an empty database,
      // and offering "add your first contact" to someone who just mistyped a
      // name would be unhelpful.
      return search.length > 0 ? (
        <EmptyState
          icon={<NoResultsIcon className="h-5 w-5" />}
          title={t('contacts.noResults.title')}
          description={t('contacts.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('common.clearSearch')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('contacts.empty.title')}
          description={t('contacts.empty.description')}
          icon={<ContactsIcon className="h-5 w-5" />}
          action={
            <>
              <Button onClick={() => setCreating(true)}>
                <PlusIcon className="h-4 w-4" />
                {t('contacts.empty.action')}
              </Button>
              <ImportLink objectType="contact" />
            </>
          }
        />
      );
    }

    return (
      <div className="space-y-4">
        <ContactsTable contacts={contacts} customColumns={customColumns.chosenDefinitions} />
        <ListFooter
          end={
            query.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('contacts.loadMore')}
              </Button>
            ) : undefined
          }
        >
          {contacts.length} {t('contacts.count')}
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
        title={t('contacts.title')}
        actions={
          <Button onClick={() => setCreating(true)} aria-keyshortcuts="C">
            <PlusIcon className="h-4 w-4" />
            {t('contacts.new')}
          </Button>
        }
      />

      <Toolbar
        start={
          <SearchField
            id="contact-search"
            label={t('contacts.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('contacts.searchPlaceholder')}
            wrapperClassName="w-full sm:w-72"
          />
        }
        end={
          <>
            <CustomColumnsChooser state={customColumns} />
            <ImportLink objectType="contact" />
            <ExportButton objectType="contact" q={search} sort="-created_at" />
          </>
        }
      />

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
