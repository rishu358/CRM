'use client';

import { MAX_FORM_FIELDS } from '@crm/core';
import type { LeadForm, LeadFormIssued, LeadFormSetup } from '@crm/contracts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  Checkbox,
  CloseIcon,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  Select,
  Textarea,
  cn,
} from '@crm/ui';
import { useState } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import {
  useCreateLeadForm,
  useDeleteLeadForm,
  useLeadFormSetup,
  useLeadForms,
  usePauseLeadForms,
  useRevokeLeadFormKeys,
  useRotateLeadFormKey,
  useUpdateLeadForm,
} from '../lib/lead-forms';
import { AppShell } from './app-shell';
import { LeadFormFields, type FieldValue, type FieldValues } from './lead-form-fields';

/**
 * Web forms: the administration screen (ADR-0065).
 *
 * A company builds a form from its own lead fields, writes the consent wording, names the websites
 * that may show it, and copies the link or the embed code. The screen mirrors what the API enforces
 * (which fields a form may ask for, the limits, the redirect rule) so a person is told before they
 * click; every rule is checked again by the server, and its answer is what is shown.
 *
 * **The key is shown once.** The answer to creating a form or making a new key carries it; it lives
 * in this component's state until the person says they have copied it, and is not put in the query
 * cache. Nothing on the screen can show it again, because the server no longer has it.
 *
 * Whether a person may be here is the API's answer (a 403 on the list), never a guess from a role
 * name; hiding the nav link is cosmetic.
 */

export function WebFormsScreen() {
  const forms = useLeadForms();
  const setup = useLeadFormSetup();
  const pause = usePauseLeadForms();
  const [editing, setEditing] = useState<LeadForm | 'new' | null>(null);
  const [issued, setIssued] = useState<LeadFormIssued | null>(null);

  const header = <PageHeader title={t('webForms.title')} description={t('webForms.description')} />;

  const failure = forms.error ?? setup.error;
  if (failure !== null) {
    return (
      <AppShell>
        {header}
        {failure.status === 403 ? (
          <NoPermissionState
            title={t('webForms.forbidden.title')}
            description={t('webForms.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('webForms.error.title')}
            description={t('webForms.error.description')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  void forms.refetch();
                  void setup.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </AppShell>
    );
  }

  if (forms.data === undefined || setup.data === undefined) {
    return (
      <AppShell>
        {header}
        <CardSkeleton rows={4} label={t('common.loading')} />
      </AppShell>
    );
  }

  const list = forms.data.data;
  const options = setup.data.data;

  return (
    <AppShell>
      {editing === null ? (
        <PageHeader
          title={t('webForms.title')}
          description={t('webForms.description')}
          actions={
            <Button onClick={() => setEditing('new')} disabled={list.length >= options.maxForms}>
              <PlusIcon className="h-4 w-4" />
              {t('webForms.new')}
            </Button>
          }
        />
      ) : (
        header
      )}

      {options.paused ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-border bg-card p-3 text-sm"
          data-testid="web-forms-paused"
        >
          {t('webForms.pause.banner')}
        </p>
      ) : null}

      {editing === null ? (
        <div className="space-y-6">
          <Card>
            <CardBody>
              <Checkbox
                label={t('webForms.pause.label')}
                description={t('webForms.pause.description')}
                checked={options.paused}
                disabled={pause.isPending}
                onChange={(event) => pause.mutate(event.target.checked)}
              />
            </CardBody>
          </Card>

          {list.length === 0 ? (
            <EmptyState
              title={t('webForms.empty.title')}
              description={t('webForms.empty.description')}
              action={<Button onClick={() => setEditing('new')}>{t('webForms.new')}</Button>}
            />
          ) : (
            <>
              <ul className="space-y-3" data-testid="web-form-list">
                {list.map((form) => (
                  <li key={form.id}>
                    <FormCard form={form} onEdit={() => setEditing(form)} />
                  </li>
                ))}
              </ul>
              <p className="figures text-xs text-muted-foreground">
                {t('webForms.limit', { count: list.length, max: options.maxForms })}
              </p>
            </>
          )}
        </div>
      ) : (
        <WebFormEditor
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`}
          setup={options}
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onIssued={setIssued}
          onSaved={(saved) => setEditing(saved)}
        />
      )}

      {issued === null ? null : <IssuedDialog issued={issued} onClose={() => setIssued(null)} />}
    </AppShell>
  );
}

function FormCard({ form, onEdit }: { form: LeadForm; onEdit: () => void }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {form.name}
            <Badge tone={form.status === 'enabled' ? 'success' : 'neutral'}>
              {form.status === 'enabled'
                ? t('webForms.status.enabled')
                : t('webForms.status.disabled')}
            </Badge>
          </span>
        }
        description={
          <span className="figures">
            {t('webForms.stats', {
              today: form.stats.today,
              week: form.stats.last7Days,
              total: form.stats.total,
            })}
            {' · '}
            {form.stats.lastSubmittedAt === null
              ? t('webForms.noLeadsYet')
              : t('webForms.lastLead', {
                  when: formatDateTime(form.stats.lastSubmittedAt, DEFAULT_PREFERENCES),
                })}
          </span>
        }
        actions={
          <Button variant="outline" onClick={onEdit}>
            {t('webForms.edit')}
          </Button>
        }
      />
      <CardBody>
        <p className="text-sm text-muted-foreground">
          {form.keyHint === null
            ? t('webForms.noKey')
            : t('webForms.keyHint', { hint: form.keyHint })}
        </p>
      </CardBody>
    </Card>
  );
}

interface FieldRow {
  key: string;
  label: string;
  required: boolean;
  helpText: string;
}

function rowsOf(form: LeadForm | null, setup: LeadFormSetup): FieldRow[] {
  if (form !== null) {
    return form.fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      helpText: field.helpText ?? '',
    }));
  }
  const label = (key: string, fallback: string) =>
    setup.fields.find((field) => field.key === key)?.label ?? fallback;
  return [
    { key: 'last_name', label: label('last_name', 'Name'), required: true, helpText: '' },
    { key: 'email', label: label('email', 'Email'), required: false, helpText: '' },
    { key: 'phone', label: label('phone', 'Phone'), required: false, helpText: '' },
  ].filter((row) => row.key === 'last_name' || setup.fields.some((field) => field.key === row.key));
}

/** The server's sentence for a path, if it sent one for it. */
function problem(error: ApiRequestError | null, path: string): string | undefined {
  return error?.error.details.find((detail) => detail.path === path)?.message;
}

function WebFormEditor({
  setup,
  form,
  onClose,
  onIssued,
  onSaved,
}: {
  setup: LeadFormSetup;
  form: LeadForm | null;
  onClose: () => void;
  onIssued: (issued: LeadFormIssued) => void;
  onSaved: (form: LeadForm) => void;
}) {
  const create = useCreateLeadForm();
  const update = useUpdateLeadForm(form?.id ?? '');
  const remove = useDeleteLeadForm(form?.id ?? '');

  const [name, setName] = useState(form?.name ?? '');
  const [rows, setRows] = useState<FieldRow[]>(() => rowsOf(form, setup));
  const [consentText, setConsentText] = useState(form?.consentText ?? '');
  const [privacyUrl, setPrivacyUrl] = useState(form?.privacyUrl ?? '');
  const [successMessage, setSuccessMessage] = useState(
    form?.successMessage ?? t('webForms.editor.successDefault'),
  );
  const [successRedirectUrl, setSuccessRedirectUrl] = useState(form?.successRedirectUrl ?? '');
  const [origins, setOrigins] = useState((form?.allowedOrigins ?? []).join('\n'));
  const [phoneCode, setPhoneCode] = useState(
    form === null ? (setup.defaultPhoneCountryCode ?? '') : (form.phoneCountryCode ?? ''),
  );
  const [enabled, setEnabled] = useState((form?.status ?? 'enabled') === 'enabled');
  const [adding, setAdding] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);

  const mutation = form === null ? create : update;
  const error: ApiRequestError | null = mutation.error;
  const stale = error?.status === 409 && error.code === 'VERSION_CONFLICT';

  const available = setup.fields.filter((field) => !rows.some((row) => row.key === field.key));
  const definitionOf = (key: string) => setup.fields.find((field) => field.key === key);

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setRows(next);
  };

  const patchRow = (index: number, change: Partial<FieldRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const addField = () => {
    const field = setup.fields.find((candidate) => candidate.key === adding);
    if (field === undefined) return;
    setRows((current) => [
      ...current,
      { key: field.key, label: field.label, required: false, helpText: '' },
    ]);
    setAdding('');
  };

  const body = () => ({
    name,
    fields: rows.map((row) => ({
      key: row.key,
      label: row.label,
      required: row.required,
      ...(row.helpText.trim() === '' ? {} : { helpText: row.helpText.trim() }),
    })),
    consentText,
    privacyUrl: privacyUrl.trim() === '' ? null : privacyUrl.trim(),
    successMessage,
    successRedirectUrl: successRedirectUrl.trim() === '' ? null : successRedirectUrl.trim(),
    allowedOrigins: origins
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    phoneCountryCode: phoneCode.trim() === '' ? null : phoneCode.trim(),
  });

  const save = () => {
    setSaved(false);
    if (form === null) {
      create.mutate(body(), {
        onSuccess: (issued) => {
          onIssued(issued);
          onSaved(issued.form);
        },
      });
    } else {
      update.mutate(
        { ...body(), status: enabled ? 'enabled' : 'disabled', version: form.version },
        {
          onSuccess: (updated) => {
            setSaved(true);
            onSaved(updated);
          },
        },
      );
    }
  };

  const previewFields = rows.map((row) => {
    const definition = definitionOf(row.key);
    return {
      key: row.key,
      label: row.label,
      type: definition?.type ?? 'text',
      required: row.required,
      helpText: row.helpText === '' ? null : row.helpText,
      options: definition?.options,
    };
  });
  const [previewValues, setPreviewValues] = useState<FieldValues>({});
  const [previewConsent, setPreviewConsent] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" onClick={onClose}>
          {t('webForms.editor.cancel')}
        </Button>
      </div>

      {stale ? (
        <Card>
          <CardBody>
            <p role="alert" className="text-sm font-medium">
              {t('webForms.editor.conflictTitle')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('webForms.editor.conflictBody')}
            </p>
            <Button className="mt-3" variant="outline" onClick={onClose}>
              {t('webForms.editor.reload')}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={form === null ? t('webForms.editor.titleNew') : t('webForms.editor.titleEdit')}
            />
            <CardBody className="space-y-4">
              <Input
                label={t('webForms.editor.name')}
                hint={t('webForms.editor.nameHint')}
                error={problem(error, 'name')}
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {form === null ? null : (
                <Checkbox
                  label={t('webForms.editor.status')}
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t('webForms.editor.fields')}
              description={t('webForms.editor.fieldsHint')}
            />
            <CardBody className="space-y-4">
              {problem(error, 'fields') === undefined ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {problem(error, 'fields')}
                </p>
              )}
              <ul className="space-y-4" data-testid="web-form-fields">
                {rows.map((row, index) => {
                  const definition = definitionOf(row.key);
                  const mandatory = definition?.mandatory === true;
                  return (
                    <li key={row.key} className="rounded-md border border-border p-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          label={`${t('webForms.editor.label')}: ${definition?.label ?? row.key}`}
                          error={problem(error, `fields.${index}.key`)}
                          maxLength={80}
                          value={row.label}
                          onChange={(event) => patchRow(index, { label: event.target.value })}
                        />
                        <Input
                          label={t('webForms.editor.helpText')}
                          maxLength={200}
                          value={row.helpText}
                          onChange={(event) => patchRow(index, { helpText: event.target.value })}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <Checkbox
                          label={t('webForms.editor.required')}
                          checked={row.required}
                          disabled={mandatory}
                          onChange={(event) => patchRow(index, { required: event.target.checked })}
                        />
                        <div className="flex items-center gap-1">
                          <IconButton
                            label={t('webForms.editor.moveUp', { field: row.label })}
                            icon={<ArrowUpIcon className="h-4 w-4" />}
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          />
                          <IconButton
                            label={t('webForms.editor.moveDown', { field: row.label })}
                            icon={<ArrowDownIcon className="h-4 w-4" />}
                            disabled={index === rows.length - 1}
                            onClick={() => move(index, 1)}
                          />
                          <IconButton
                            label={t('webForms.editor.remove', { field: row.label })}
                            icon={<CloseIcon className="h-4 w-4" />}
                            disabled={mandatory}
                            onClick={() =>
                              setRows((current) => current.filter((_, i) => i !== index))
                            }
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {available.length === 0 || rows.length >= MAX_FORM_FIELDS ? (
                <p className="text-sm text-muted-foreground">{t('webForms.editor.addFieldNone')}</p>
              ) : (
                <div className="flex items-end gap-2">
                  <Select
                    label={t('webForms.editor.addField')}
                    value={adding}
                    onChange={(event) => setAdding(event.target.value)}
                    className="min-w-56"
                  >
                    <option value="">{t('publicForm.chooseOne')}</option>
                    {available.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label}
                      </option>
                    ))}
                  </Select>
                  <Button variant="outline" disabled={adding === ''} onClick={addField}>
                    <PlusIcon className="h-4 w-4" />
                    {t('webForms.editor.addFieldAction')}
                  </Button>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('webForms.editor.consent')} />
            <CardBody className="space-y-4">
              <Textarea
                label={t('webForms.editor.consent')}
                hint={t('webForms.editor.consentHint')}
                error={problem(error, 'consentText')}
                rows={4}
                maxLength={1000}
                value={consentText}
                onChange={(event) => setConsentText(event.target.value)}
              />
              <Input
                label={t('webForms.editor.privacyUrl')}
                hint={t('webForms.editor.privacyUrlHint')}
                error={problem(error, 'privacyUrl')}
                type="url"
                value={privacyUrl}
                onChange={(event) => setPrivacyUrl(event.target.value)}
              />
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4">
              <Textarea
                label={t('webForms.editor.successMessage')}
                error={problem(error, 'successMessage')}
                rows={2}
                maxLength={500}
                value={successMessage}
                onChange={(event) => setSuccessMessage(event.target.value)}
              />
              <Textarea
                label={t('webForms.editor.origins')}
                hint={t('webForms.editor.originsHint')}
                error={
                  error?.error.details.find((detail) => detail.path?.startsWith('allowedOrigins'))
                    ?.message
                }
                rows={3}
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
              />
              <Input
                label={t('webForms.editor.successRedirect')}
                hint={t('webForms.editor.successRedirectHint')}
                error={problem(error, 'successRedirectUrl')}
                type="url"
                value={successRedirectUrl}
                onChange={(event) => setSuccessRedirectUrl(event.target.value)}
              />
              <Input
                label={t('webForms.editor.phoneCode')}
                hint={t('webForms.editor.phoneCodeHint')}
                error={problem(error, 'phoneCountryCode')}
                inputMode="numeric"
                maxLength={4}
                wrapperClassName="max-w-40"
                value={phoneCode}
                onChange={(event) => setPhoneCode(event.target.value)}
              />
            </CardBody>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={mutation.isPending}>
              {form === null ? t('webForms.editor.create') : t('webForms.editor.save')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('webForms.editor.cancel')}
            </Button>
            {saved ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('webForms.editor.saved')}
              </p>
            ) : null}
            {error !== null && !stale && error.error.details.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            ) : null}
            {form === null ? null : (
              <Button
                variant="destructive"
                className="ml-auto"
                onClick={() => setConfirmDelete(true)}
              >
                {t('webForms.editor.delete')}
              </Button>
            )}
          </div>

          {form === null ? null : <KeyCard form={form} onIssued={onIssued} onSaved={onSaved} />}
        </div>

        <div className={cn('lg:sticky lg:top-4 lg:self-start')}>
          <Card data-testid="web-form-preview">
            <CardHeader
              title={t('webForms.editor.preview')}
              description={t('webForms.editor.previewNote')}
            />
            <CardBody className="space-y-4">
              <p className="text-base font-semibold">{name === '' ? ' ' : name}</p>
              <LeadFormFields
                idPrefix="preview"
                fields={previewFields}
                values={previewValues}
                errors={{}}
                onChange={(key: string, value: FieldValue) =>
                  setPreviewValues((current) => ({ ...current, [key]: value }))
                }
              />
              <Checkbox
                label={consentText === '' ? ' ' : consentText}
                checked={previewConsent}
                onChange={(event) => setPreviewConsent(event.target.checked)}
              />
              <Button type="button" disabled>
                {t('publicForm.submit')}
              </Button>
            </CardBody>
          </Card>
        </div>
      </div>

      {confirmDelete && form !== null ? (
        <Dialog
          title={t('webForms.editor.deleteTitle')}
          description={t('webForms.editor.deleteBody')}
          closeLabel={t('common.close')}
          onClose={() => setConfirmDelete(false)}
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('webForms.editor.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => remove.mutate(form.version, { onSuccess: onClose })}
            >
              {t('webForms.editor.deleteConfirm')}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}

const GRACE_CHOICES = [
  { hours: 24, label: 'webForms.key.grace24' },
  { hours: 72, label: 'webForms.key.grace72' },
  { hours: 168, label: 'webForms.key.grace168' },
  { hours: 0, label: 'webForms.key.grace0' },
] as const;

function KeyCard({
  form,
  onIssued,
  onSaved,
}: {
  form: LeadForm;
  onIssued: (issued: LeadFormIssued) => void;
  onSaved: (form: LeadForm) => void;
}) {
  const rotate = useRotateLeadFormKey(form.id);
  const revoke = useRevokeLeadFormKeys(form.id);
  const [grace, setGrace] = useState(24);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <Card data-testid="web-form-key">
      <CardHeader title={t('webForms.key.title')} description={t('webForms.key.description')} />
      <CardBody className="space-y-4">
        <p className="text-sm">
          {form.keyHint === null
            ? t('webForms.noKey')
            : t('webForms.keyHint', { hint: form.keyHint })}
        </p>
        {form.previousKeyRetiresAt === null ? null : (
          <p className="text-sm text-muted-foreground">
            {t('webForms.key.retiring', {
              when: formatDateTime(form.previousKeyRetiresAt, DEFAULT_PREFERENCES),
            })}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('webForms.key.grace')}
            value={String(grace)}
            onChange={(event) => setGrace(Number(event.target.value))}
          >
            {GRACE_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {t(choice.label)}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            loading={rotate.isPending}
            onClick={() =>
              rotate.mutate(
                { graceHours: grace, version: form.version },
                {
                  onSuccess: (issued) => {
                    onIssued(issued);
                    onSaved(issued.form);
                  },
                },
              )
            }
          >
            {t('webForms.key.rotate')}
          </Button>
          <Button variant="destructive" onClick={() => setConfirmRevoke(true)}>
            {t('webForms.key.revoke')}
          </Button>
        </div>
        {rotate.isError || revoke.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {(rotate.error ?? revoke.error)?.message}
          </p>
        ) : null}
      </CardBody>

      {confirmRevoke ? (
        <Dialog
          title={t('webForms.key.revokeTitle')}
          description={t('webForms.key.revokeBody')}
          closeLabel={t('common.close')}
          onClose={() => setConfirmRevoke(false)}
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>
              {t('webForms.editor.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(
                  { version: form.version },
                  {
                    onSuccess: (updated) => {
                      setConfirmRevoke(false);
                      onSaved(updated);
                    },
                  },
                )
              }
            >
              {t('webForms.key.revokeConfirm')}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </Card>
  );
}

function CopyBox({
  label,
  value,
  multiline,
  testId,
}: {
  label: string;
  value: string;
  multiline: boolean;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true));
  };
  return (
    <div className="space-y-1.5">
      {multiline ? (
        <Textarea
          label={label}
          readOnly
          rows={4}
          value={value}
          data-testid={testId}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : (
        <Input
          label={label}
          readOnly
          value={value}
          data-testid={testId}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <Button variant="outline" onClick={copy}>
        {copied ? t('webForms.issued.copied') : t('webForms.issued.copy')}
      </Button>
    </div>
  );
}

/** The one place a key is shown. Closing it is the person saying they have copied it. */
function IssuedDialog({ issued, onClose }: { issued: LeadFormIssued; onClose: () => void }) {
  return (
    <Dialog
      title={t('webForms.issued.title')}
      description={t('webForms.issued.warning')}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
      data-testid="web-form-issued"
    >
      <div className="space-y-5">
        <CopyBox
          label={t('webForms.issued.link')}
          value={issued.link}
          multiline={false}
          testId="web-form-link"
        />
        <div>
          <CopyBox
            label={t('webForms.issued.snippet')}
            value={issued.snippet}
            multiline
            testId="web-form-snippet"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('webForms.issued.snippetHint')}</p>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t('webForms.issued.done')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
