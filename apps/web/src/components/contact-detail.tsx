'use client';

import { useEffect } from 'react';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  NoPermissionState,
  Skeleton,
} from '@crm/ui';
import Link from 'next/link';
import { useContact, useUpdateContact } from '../lib/contacts';
import { DEFAULT_PREFERENCES, formatDateTime, formatName } from '../lib/format';
import { t } from '../lib/i18n';
import { useRecordView } from '../lib/activities';
import { AppShell } from './app-shell';
import { ActivityPanel } from './activity-panel';
import { AttachmentPanel } from './attachment-panel';
import { InlineField } from './inline-field';

/**
 * One contact, edited in place.
 *
 * Which fields appear is decided by what the API returned: a field the caller
 * may not read is absent from the payload entirely (CLAUDE.md §5.4), so the
 * form is built from the response rather than from a fixed list. That also
 * means a field hidden by configuration simply does not render — no empty row
 * hinting that something is being withheld.
 */
const EDITABLE_FIELDS = [
  { key: 'firstName', label: 'contact.firstName', type: 'text' },
  { key: 'lastName', label: 'contact.lastName', type: 'text' },
  { key: 'email', label: 'contact.email', type: 'email' },
  { key: 'phone', label: 'contact.phone', type: 'tel' },
  { key: 'whatsapp', label: 'contact.whatsapp', type: 'tel' },
  { key: 'title', label: 'contact.title', type: 'text' },
  { key: 'leadSource', label: 'contact.leadSource', type: 'text' },
] as const;

export function ContactDetail({ id }: { id: string }) {
  /*
   * Tell the server this record was opened, for My Day's "recently viewed"
   * (MVP_SPEC M6). A write the client makes rather than something the GET
   * does for it, so a read stays a read. Failures are ignored: the list is a
   * convenience, and nobody should see an error because the bookkeeping
   * behind it did not land.
   */
  const { mutate: recordView } = useRecordView();
  useEffect(() => {
    recordView({ objectType: 'contact', recordId: id });
  }, [id, recordView]);

  const query = useContact(id);
  const update = useUpdateContact();

  if (query.isPending) {
    return (
      <AppShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppShell>
    );
  }

  if (query.isError) {
    const status = query.error.status;
    return (
      <AppShell>
        {status === 403 ? (
          <NoPermissionState
            title={t('contacts.forbidden.title')}
            description={t('contacts.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={status === 404 ? t('contact.notFound.title') : t('contacts.error.title')}
            description={
              status === 404 ? t('contact.notFound.description') : t('contacts.error.description')
            }
            action={
              <Link href="/contacts">
                <Button variant="outline">{t('contact.backToList')}</Button>
              </Link>
            }
          />
        )}
      </AppShell>
    );
  }

  const contact = query.data.data;
  const record = contact as unknown as Record<string, unknown>;

  // A 409 means a colleague saved while this user was editing. Offering a
  // reload is the honest response: we will not guess whose version wins.
  const conflicted = update.error?.code === 'VERSION_CONFLICT';

  return (
    <AppShell>
      <nav className="mb-4">
        <Link
          href="/contacts"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('contact.backToList')}
        </Link>
      </nav>

      <h1 className="mb-6 text-xl font-semibold tracking-tight">
        {formatName(contact) || t('field.empty')}
      </h1>

      {conflicted ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3"
        >
          <div>
            <p className="text-sm font-medium">{t('conflict.title')}</p>
            <p className="text-sm text-muted-foreground">{t('conflict.description')}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              update.reset();
              void query.refetch();
            }}
          >
            {t('conflict.reload')}
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader title={t('contact.details')} />
        <CardBody className="divide-y divide-border">
          {EDITABLE_FIELDS.filter((field) => field.key in record).map((field) => (
            <InlineField
              key={field.key}
              label={t(field.label)}
              type={field.type}
              value={record[field.key] as string | null | undefined}
              onSave={(next) => {
                update.mutate({
                  id: contact.id,
                  version: contact.version,
                  patch: { [field.key]: next },
                });
              }}
            />
          ))}

          <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
            <span className="text-muted-foreground">{t('contact.created')}</span>
            <span>{formatDateTime(contact.createdAt, DEFAULT_PREFERENCES)}</span>
          </div>
          <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
            <span className="text-muted-foreground">{t('contact.updated')}</span>
            <span>{formatDateTime(contact.updatedAt, DEFAULT_PREFERENCES)}</span>
          </div>
        </CardBody>
      </Card>

      <ActivityPanel objectType="contact" recordId={id} />
      <AttachmentPanel objectType="contact" recordId={id} />
    </AppShell>
  );
}
