'use client';

import { useEffect } from 'react';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  ErrorState,
  NoPermissionState,
  PageHeader,
  Skeleton,
} from '@crm/ui';
import { whatsAppTarget } from '@crm/core/whatsapp';
import Link from 'next/link';
import { useAccount, useUpdateAccount, type AddressValue } from '../lib/accounts';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';
import { useRecordView } from '../lib/activities';
import { AppShell } from './app-shell';
import { BackLink } from './back-link';
import { useBrand } from './brand-provider';
import { WhoCanSeeButton } from './who-can-see';
import { ActivityPanel } from './activity-panel';
import { AttachmentPanel } from './attachment-panel';
import { TagsCard } from './tag-editor';
import { InlineField } from './inline-field';
import { WhatsAppChat } from './whatsapp-chat';
import { CustomFieldsCard } from './custom-fields';
import { InlineMoneyField } from './inline-money-field';

/**
 * One account, edited in place.
 *
 * Which fields appear is decided by what the API returned: a field the caller
 * may not read is absent from the payload entirely (CLAUDE.md §5.4), so the
 * form is built from the response rather than from a fixed list. That also
 * means a field hidden by configuration simply does not render — no empty row
 * hinting that something is being withheld.
 */
const EDITABLE_FIELDS: readonly {
  key: string;
  label: TranslationKey;
  type: 'text' | 'email' | 'tel' | 'url' | 'number';
}[] = [
  { key: 'name', label: 'account.name', type: 'text' },
  { key: 'domain', label: 'account.domain', type: 'text' },
  { key: 'industry', label: 'account.industry', type: 'text' },
  { key: 'phone', label: 'account.phone', type: 'tel' },
  { key: 'email', label: 'account.email', type: 'email' },
  { key: 'website', label: 'account.website', type: 'url' },
  { key: 'gstin', label: 'account.gstin', type: 'text' },
  { key: 'employeeCount', label: 'account.employeeCount', type: 'number' },
];

/**
 * An address as lines, or nothing.
 *
 * Read-only here. Editing a structured address is a form, not an inline
 * field, and it belongs with the record-page layout work (MVP_SPEC M9); the
 * API accepts one today, so nothing has to change underneath when it arrives.
 */
function AddressBlock({ label, address }: { label: string; address: AddressValue | null }) {
  const lines = [
    address?.line1,
    address?.line2,
    [address?.city, address?.state].filter(Boolean).join(', '),
    [address?.postalCode, address?.country].filter(Boolean).join(' '),
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);

  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {lines.length === 0 ? (
        <span className="text-muted-foreground">{t('field.empty')}</span>
      ) : (
        <address className="not-italic">
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
      )}
    </div>
  );
}

/**
 * The parent company, by name.
 *
 * A second request, deliberately: `parent_account_id` is an id and the list
 * endpoint does not join. The parent may also be outside this user's record
 * scope, in which case that request is a 404 and the link falls back to a
 * neutral label — this page must not reach around the scope check to show a
 * name the user is not allowed to read (CLAUDE.md §5.5).
 */
function ParentAccountLink({ id }: { id: string }) {
  const parent = useAccount(id);
  const name = parent.data?.data.name;

  return (
    <Link href={`/accounts/${id}`} className="text-primary underline-offset-4 hover:underline">
      {name === undefined || name.length === 0 ? t('account.parent.view') : name}
    </Link>
  );
}

export function AccountDetail({ id }: { id: string }) {
  /*
   * Tell the server this record was opened, for My Day's "recently viewed"
   * (MVP_SPEC M6). A write the client makes rather than something the GET
   * does for it, so a read stays a read. Failures are ignored: the list is a
   * convenience, and nobody should see an error because the bookkeeping
   * behind it did not land.
   */
  const { mutate: recordView } = useRecordView();
  useEffect(() => {
    recordView({ objectType: 'account', recordId: id });
  }, [id, recordView]);

  const query = useAccount(id);
  const update = useUpdateAccount();
  const { whatsappLinkBase } = useBrand();

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
            title={t('accounts.forbidden.title')}
            description={t('accounts.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={status === 404 ? t('account.notFound.title') : t('accounts.error.title')}
            description={
              status === 404 ? t('account.notFound.description') : t('accounts.error.description')
            }
            action={
              <Link href="/accounts">
                <Button variant="outline">{t('account.backToList')}</Button>
              </Link>
            }
          />
        )}
      </AppShell>
    );
  }

  const account = query.data.data;
  const record = account as unknown as Record<string, unknown>;
  // Accounts carry a phone number only, so a chat always uses it.
  const chat = whatsAppTarget(whatsappLinkBase, account);

  // A 409 means a colleague saved while this user was editing. Offering a
  // reload is the honest response: we will not guess whose version wins.
  const conflicted = update.error?.code === 'VERSION_CONFLICT';
  // Anything else the API refused — a malformed GSTIN, a parent that would
  // close a cycle. Shown rather than swallowed; the optimistic value has
  // already been rolled back by the mutation's onError.
  const rejected = update.error !== null && !conflicted ? update.error.message : null;

  const save = (patch: Record<string, unknown>) => {
    update.mutate({ id: account.id, version: account.version, patch });
  };

  return (
    <AppShell>
      <PageHeader
        back={<BackLink href="/accounts">{t('account.backToList')}</BackLink>}
        title={account.name ?? t('field.empty')}
        actions={
          <WhoCanSeeButton
            objectType="account"
            recordId={id}
            subject={t('whoCanSee.subject.account')}
          />
        }
      />

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

      {rejected === null ? null : (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm">
          {rejected}
        </p>
      )}

      {/*
        Details beside the timeline from `xl`, stacked below it. The timeline is
        "one timeline per record" (UX §5): it should be on screen with the
        fields, not a scroll away from them.
      */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title={t('account.details')} />
            <CardBody className="divide-y divide-border px-5 py-1">
              {EDITABLE_FIELDS.filter((field) => field.key in record).map((field) => (
                <InlineField
                  key={field.key}
                  label={t(field.label)}
                  type={field.type}
                  value={
                    record[field.key] === null || record[field.key] === undefined
                      ? null
                      : String(record[field.key])
                  }
                  trailing={
                    chat?.source === field.key ? (
                      <WhatsAppChat name={account.name ?? ''} target={chat} />
                    ) : undefined
                  }
                  onSave={(next) => {
                    // A number field must send a number: the API rejects "12" for
                    // employeeCount, correctly, as the wrong type.
                    const value = field.type === 'number' && next !== null ? Number(next) : next;
                    save({ [field.key]: value });
                  }}
                />
              ))}

              {'annualRevenue' in record ? (
                <InlineMoneyField
                  label={t('account.annualRevenue')}
                  value={account.annualRevenue}
                  onSave={(next) => save({ annualRevenue: next })}
                />
              ) : null}

              {'parentAccountId' in record ? (
                <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
                  <span className="pt-1.5 text-muted-foreground">{t('account.parent')}</span>
                  {account.parentAccountId == null ? (
                    <span className="text-muted-foreground">{t('account.parent.none')}</span>
                  ) : (
                    <ParentAccountLink id={account.parentAccountId} />
                  )}
                </div>
              ) : null}

              <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
                <span className="pt-1.5 text-muted-foreground">{t('account.created')}</span>
                <span className="px-2 pt-1.5">
                  {formatDateTime(account.createdAt, DEFAULT_PREFERENCES)}
                </span>
              </div>
              <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1 text-sm">
                <span className="pt-1.5 text-muted-foreground">{t('account.updated')}</span>
                <span className="px-2 pt-1.5">
                  {formatDateTime(account.updatedAt, DEFAULT_PREFERENCES)}
                </span>
              </div>
            </CardBody>
          </Card>

          {'billingAddress' in record || 'shippingAddress' in record ? (
            <Card>
              <CardHeader title={t('account.addresses')} />
              <CardBody className="divide-y divide-border px-5 py-1">
                {'billingAddress' in record ? (
                  <AddressBlock
                    label={t('account.billingAddress')}
                    address={account.billingAddress ?? null}
                  />
                ) : null}
                {'shippingAddress' in record ? (
                  <AddressBlock
                    label={t('account.shippingAddress')}
                    address={account.shippingAddress ?? null}
                  />
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <TagsCard objectType="account" recordId={id} tags={account.tags} />
          <CustomFieldsCard
            objectType="account"
            values={account.customFields}
            onSave={(key, value) => {
              update.mutate({
                id: account.id,
                version: account.version,
                patch: { customFields: { [key]: value } },
              });
            }}
          />
        </div>
        <ActivityPanel objectType="account" recordId={id} />
        <AttachmentPanel objectType="account" recordId={id} />
      </div>
    </AppShell>
  );
}
