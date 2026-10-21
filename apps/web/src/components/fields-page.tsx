'use client';

import { MAX_CUSTOM_FIELDS_PER_OBJECT } from '@crm/core';
import type {
  CustomizableObjectName,
  FieldCreateInput,
  FieldDefinitionView,
  FieldUpdateInput,
} from '@crm/contracts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  CustomizeIcon,
  Dialog,
  EditIcon,
  EmptyState,
  ErrorState,
  IconButton,
  LockIcon,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  SegmentedControl,
  Skeleton,
  cn,
} from '@crm/ui';
import { useState } from 'react';
import { useCreateField, useManagedFields, useOrderFields, useUpdateField } from '../lib/fields';
import { t, type TranslationKey } from '../lib/i18n';
import { AppShell } from './app-shell';
import { FieldDialog } from './field-dialog';

/**
 * Customization (MVP_SPEC M9): the company's own fields on its records.
 *
 * Built-in fields are listed so the picture is whole, and are not editable: the
 * screens that draw them have their own labels, so a rename here would be invisible
 * where it matters. Custom fields can be added, edited, reordered and switched off.
 * There is no delete anywhere on this screen, deliberately — switching off hides a
 * field and keeps what was entered, and says so before it does.
 *
 * Whether the signed-in person may be here is the API's answer (a 403 on the list),
 * never inferred from a role name; hiding the nav link is cosmetic.
 */
const OBJECTS: readonly { value: CustomizableObjectName; label: TranslationKey }[] = [
  { value: 'contact', label: 'nav.contacts' },
  { value: 'account', label: 'nav.accounts' },
  { value: 'lead', label: 'nav.leads' },
  { value: 'deal', label: 'nav.deals' },
];

function typeLabel(type: string): string {
  return t(`fields.type.${type}` as TranslationKey);
}

type DialogState =
  { readonly mode: 'add' } | { readonly mode: 'edit'; readonly field: FieldDefinitionView };

export function FieldsScreen() {
  const [objectType, setObjectType] = useState<CustomizableObjectName>('contact');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [switchingOff, setSwitchingOff] = useState<FieldDefinitionView | null>(null);

  const query = useManagedFields(objectType);
  const create = useCreateField();
  const update = useUpdateField();
  const order = useOrderFields();

  const header = (
    <PageHeader
      title={t('fields.title')}
      description={t('fields.description')}
      actions={
        <Button
          onClick={() => {
            create.reset();
            setDialog({ mode: 'add' });
          }}
          disabled={!query.isSuccess}
        >
          <PlusIcon className="h-4 w-4" />
          {t('fields.add')}
        </Button>
      }
    />
  );

  const switcher = (
    <div className="mb-5">
      <SegmentedControl
        label={t('fields.object')}
        value={objectType}
        options={OBJECTS.map((object) => ({ value: object.value, label: t(object.label) }))}
        onChange={setObjectType}
      />
    </div>
  );

  if (query.isError) {
    return (
      <AppShell>
        {header}
        {switcher}
        {query.error.status === 403 ? (
          <NoPermissionState
            title={t('fields.forbidden.title')}
            description={t('fields.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('fields.error.title')}
            description={t('fields.error.description')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </AppShell>
    );
  }

  const fields = query.data?.data ?? [];
  const custom = fields.filter((field) => !field.isSystem);
  const builtIn = fields.filter((field) => field.isSystem);
  const full = custom.length >= MAX_CUSTOM_FIELDS_PER_OBJECT;

  const move = (index: number, by: -1 | 1) => {
    const ids = custom.map((field) => field.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    const moved = ids.splice(index, 1)[0];
    if (moved !== undefined) ids.splice(target, 0, moved);
    order.mutate({ objectType, ids });
  };

  const setActive = (field: FieldDefinitionView, isActive: boolean) =>
    update.mutate(
      { id: field.id, input: { version: field.version, isActive } },
      { onSuccess: () => setSwitchingOff(null) },
    );

  return (
    <AppShell>
      {header}
      {switcher}

      {query.isPending ? (
        <div className="space-y-6">
          <CardSkeleton rows={4} label={t('common.loading')} />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card data-testid="custom-fields-list">
            <CardHeader
              title={t('fields.custom.title')}
              description={
                <>
                  {t('fields.custom.description')}{' '}
                  <span className="figures">
                    {t('fields.count', { count: custom.length, max: MAX_CUSTOM_FIELDS_PER_OBJECT })}
                  </span>
                </>
              }
            />
            <CardBody className={custom.length === 0 ? undefined : 'p-0'}>
              {custom.length === 0 ? (
                <EmptyState
                  compact
                  icon={<CustomizeIcon className="h-5 w-5" />}
                  title={t('fields.empty.title')}
                  description={t('fields.empty.description')}
                  action={
                    <Button
                      variant="outline"
                      onClick={() => {
                        create.reset();
                        setDialog({ mode: 'add' });
                      }}
                    >
                      {t('fields.add')}
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-border">
                  {custom.map((field, index) => (
                    <li
                      key={field.id}
                      className={cn(
                        'flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3',
                        !field.isActive && 'bg-muted/40',
                      )}
                    >
                      <div className="min-w-0 flex-1 basis-60">
                        <p className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              'font-medium',
                              !field.isActive && 'text-muted-foreground',
                            )}
                          >
                            {field.label}
                          </span>
                          {field.required ? (
                            <Badge tone="primary">{t('fields.badge.required')}</Badge>
                          ) : null}
                          {field.isActive ? null : (
                            <Badge tone="warning">{t('fields.badge.off')}</Badge>
                          )}
                        </p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {typeLabel(field.type)}
                          {field.section === null
                            ? ''
                            : ` · ${t('fields.row.section', { section: field.section })}`}
                          {field.options === undefined
                            ? ''
                            : ` · ${t('fields.row.options', { offered: field.options.filter((o) => o.isActive !== false).length, total: field.options.length })}`}
                        </p>
                        {field.helpText === null ? null : (
                          <p className="mt-0.5 text-sm text-muted-foreground">{field.helpText}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <IconButton
                          label={t('fields.row.moveUp', { label: field.label })}
                          icon={<ArrowUpIcon className="h-4 w-4" />}
                          size="icon-sm"
                          disabled={index === 0 || order.isPending}
                          onClick={() => move(index, -1)}
                        />
                        <IconButton
                          label={t('fields.row.moveDown', { label: field.label })}
                          icon={<ArrowDownIcon className="h-4 w-4" />}
                          size="icon-sm"
                          disabled={index === custom.length - 1 || order.isPending}
                          onClick={() => move(index, 1)}
                        />
                        <IconButton
                          label={t('fields.row.edit', { label: field.label })}
                          icon={<EditIcon className="h-4 w-4" />}
                          size="icon-sm"
                          onClick={() => {
                            update.reset();
                            setDialog({ mode: 'edit', field });
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={
                            field.isActive
                              ? t('fields.row.switchOff', { label: field.label })
                              : t('fields.row.switchOn', { label: field.label })
                          }
                          onClick={() =>
                            field.isActive ? setSwitchingOff(field) : setActive(field, true)
                          }
                        >
                          {field.isActive
                            ? t('fields.switchOff.confirm')
                            : t('fields.switchOn.confirm')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
            {full ? (
              <p
                role="status"
                className="border-t border-border px-5 py-3 text-sm text-muted-foreground"
              >
                {t('fields.limitReached', { max: MAX_CUSTOM_FIELDS_PER_OBJECT })}
              </p>
            ) : null}
          </Card>

          {order.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('fields.saveError')}
            </p>
          ) : null}

          <Card>
            <CardHeader
              title={t('fields.builtIn.title')}
              description={t('fields.builtIn.description')}
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {builtIn.map((field) => (
                  <li key={field.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <LockIcon
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{field.label}</span>
                    <span className="shrink-0 text-muted-foreground">{typeLabel(field.type)}</span>
                    {field.required ? (
                      <Badge tone="neutral">{t('fields.badge.required')}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      {dialog === null ? null : (
        <FieldDialog
          objectType={objectType}
          field={dialog.mode === 'edit' ? dialog.field : null}
          pending={dialog.mode === 'edit' ? update.isPending : create.isPending}
          error={dialog.mode === 'edit' ? (update.error ?? null) : (create.error ?? null)}
          onClose={() => setDialog(null)}
          onReload={() => {
            update.reset();
            setDialog(null);
            void query.refetch();
          }}
          onSubmit={(input) => {
            if (dialog.mode === 'edit') {
              update.mutate(
                { id: dialog.field.id, input: input as FieldUpdateInput },
                { onSuccess: () => setDialog(null) },
              );
            } else {
              create.mutate(input as FieldCreateInput, { onSuccess: () => setDialog(null) });
            }
          }}
        />
      )}

      {switchingOff === null ? null : (
        <Dialog
          title={t('fields.switchOff.title', { label: switchingOff.label })}
          closeLabel={t('common.close')}
          onClose={() => setSwitchingOff(null)}
        >
          <p className="text-sm text-muted-foreground">{t('fields.switchOff.body')}</p>
          {update.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {t('fields.saveError')}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSwitchingOff(null)}>
              {t('fields.switchOff.cancel')}
            </Button>
            <Button loading={update.isPending} onClick={() => setActive(switchingOff, false)}>
              {t('fields.switchOff.confirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </AppShell>
  );
}
