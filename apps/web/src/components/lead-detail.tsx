'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  ErrorState,
  NoPermissionState,
  PageHeader,
  Select,
  Skeleton,
} from '@crm/ui';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { DEFAULT_PREFERENCES, formatDate, formatDateTime, formatName } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';
import { OPEN_LEAD_STATUSES, useLead, useUpdateLead } from '../lib/leads';
import { useRecordView } from '../lib/activities';
import { AppShell } from './app-shell';
import { BackLink } from './back-link';
import { WhoCanSeeButton } from './who-can-see';
import { ActivityPanel } from './activity-panel';
import { AttachmentPanel } from './attachment-panel';
import { ConvertLeadDialog } from './convert-lead-dialog';
import { InlineField } from './inline-field';
import { CustomFieldsCard } from './custom-fields';

/**
 * One lead, edited in place.
 *
 * Which fields appear is decided by what the API returned: a field the caller
 * may not read is absent from the payload entirely (CLAUDE.md §5.4), so the
 * form is built from the response rather than from a fixed list. A field
 * hidden by configuration simply does not render — no empty row hinting that
 * something is being withheld.
 *
 * A converted lead is read-only here, as it is at the API (ADR-0022): it is
 * the record of what a person became, and editing it would let it drift from
 * the contact it created.
 */
const EDITABLE_FIELDS = [
  { key: 'firstName', label: 'lead.firstName', type: 'text' },
  { key: 'lastName', label: 'lead.lastName', type: 'text' },
  { key: 'company', label: 'lead.company', type: 'text' },
  { key: 'email', label: 'lead.email', type: 'email' },
  { key: 'phone', label: 'lead.phone', type: 'tel' },
  { key: 'source', label: 'lead.source', type: 'text' },
] as const;

export function LeadDetail({ id }: { id: string }) {
  /*
   * Tell the server this record was opened, for My Day's "recently viewed"
   * (MVP_SPEC M6). A write the client makes rather than something the GET
   * does for it, so a read stays a read. Failures are ignored: the list is a
   * convenience, and nobody should see an error because the bookkeeping
   * behind it did not land.
   */
  const { mutate: recordView } = useRecordView();
  useEffect(() => {
    recordView({ objectType: 'lead', recordId: id });
  }, [id, recordView]);

  const query = useLead(id);
  const update = useUpdateLead();
  const [converting, setConverting] = useState(false);

  if (query.isPending) {
    return (
      <AppShell>
        <div className="space-y-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-64" />
          <CardSkeleton rows={7} label={t('common.loading')} />
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
            title={t('leads.forbidden.title')}
            description={t('leads.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={status === 404 ? t('lead.notFound.title') : t('leads.error.title')}
            description={
              status === 404 ? t('lead.notFound.description') : t('leads.error.description')
            }
            action={
              <Link href="/leads">
                <Button variant="outline">{t('lead.backToList')}</Button>
              </Link>
            }
          />
        )}
      </AppShell>
    );
  }

  const lead = query.data.data;
  const record = lead as unknown as Record<string, unknown>;
  const converted = lead.status === 'converted';

  // A 409 means a colleague saved while this user was editing. Offering a
  // reload is the honest response: we will not guess whose version wins.
  const conflicted = update.error?.code === 'VERSION_CONFLICT';

  return (
    <AppShell>
      <PageHeader
        back={<BackLink href="/leads">{t('lead.backToList')}</BackLink>}
        title={formatName(lead) || t('field.empty')}
        meta={
          lead.status !== undefined ? (
            <Badge tone={converted ? 'success' : 'neutral'}>
              {t(`lead.status.${lead.status}` as TranslationKey)}
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <WhoCanSeeButton
              objectType="lead"
              recordId={id}
              subject={t('whoCanSee.subject.lead')}
            />
            {!converted ? (
              <Button onClick={() => setConverting(true)}>{t('lead.convert')}</Button>
            ) : null}
          </>
        }
      />

      {conflicted ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3"
        >
          <div>
            <p className="text-sm font-medium">{t('conflict.title')}</p>
            <p className="text-sm text-muted-foreground">{t('conflict.description.lead')}</p>
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

      {converted ? (
        <Card className="mb-4">
          <CardHeader
            title={t('lead.converted.title')}
            description={
              lead.convertedAt
                ? t('lead.converted.on', {
                    date: formatDate(lead.convertedAt, DEFAULT_PREFERENCES),
                  })
                : undefined
            }
          />
          <CardBody className="space-y-2 text-sm" data-testid="converted-links">
            <p className="text-muted-foreground">{t('lead.converted.locked')}</p>
            <ul className="flex flex-wrap gap-4">
              {lead.convertedContactId ? (
                <li>
                  <Link
                    href={`/contacts/${lead.convertedContactId}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('lead.converted.contact')}
                  </Link>
                </li>
              ) : null}
              {lead.convertedAccountId ? (
                <li>
                  <Link
                    href={`/accounts/${lead.convertedAccountId}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('lead.converted.account')}
                  </Link>
                </li>
              ) : null}
              {lead.convertedDealId ? (
                <li>
                  <Link
                    href={`/deals/${lead.convertedDealId}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('lead.converted.deal')}
                  </Link>
                </li>
              ) : null}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {/*
        Details beside the timeline from `xl`, stacked below it. The timeline is
        "one timeline per record" (UX §5): it should be on screen with the
        fields, not a scroll away from them.
      */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title={t('lead.details')} />
            <CardBody className="divide-y divide-border px-5 py-1">
              {EDITABLE_FIELDS.filter((field) => field.key in record).map((field) => (
                <InlineField
                  key={field.key}
                  label={t(field.label)}
                  type={field.type}
                  readOnly={converted}
                  value={record[field.key] as string | null | undefined}
                  onSave={(next) => {
                    update.mutate({
                      id: lead.id,
                      version: lead.version,
                      patch: { [field.key]: next },
                    });
                  }}
                />
              ))}

              {lead.status !== undefined && !converted ? (
                <div className="grid grid-cols-[10rem_1fr] items-center gap-3 py-1">
                  <span className="text-sm text-muted-foreground">{t('lead.status')}</span>
                  <div className="max-w-sm">
                    <Select
                      label={t('lead.status')}
                      labelHidden
                      value={lead.status}
                      onChange={(event) => {
                        update.mutate({
                          id: lead.id,
                          version: lead.version,
                          patch: { status: event.target.value },
                        });
                      }}
                    >
                      {OPEN_LEAD_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {t(`lead.status.${status}` as TranslationKey)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
                <span className="pt-1.5 text-muted-foreground">{t('lead.created')}</span>
                <span className="px-2 pt-1.5">
                  {formatDateTime(lead.createdAt, DEFAULT_PREFERENCES)}
                </span>
              </div>
              <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
                <span className="pt-1.5 text-muted-foreground">{t('lead.updated')}</span>
                <span className="px-2 pt-1.5">
                  {formatDateTime(lead.updatedAt, DEFAULT_PREFERENCES)}
                </span>
              </div>
            </CardBody>
          </Card>

          <CustomFieldsCard
            objectType="lead"
            values={lead.customFields}
            onSave={(key, value) => {
              update.mutate({
                id: lead.id,
                version: lead.version,
                patch: { customFields: { [key]: value } },
              });
            }}
          />

          {converting ? (
            <ConvertLeadDialog lead={lead} onClose={() => setConverting(false)} />
          ) : null}
        </div>
        <ActivityPanel objectType="lead" recordId={id} />
        <AttachmentPanel objectType="lead" recordId={id} />
      </div>
    </AppShell>
  );
}
