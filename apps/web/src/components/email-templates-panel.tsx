'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { emailTemplateCreateSchema } from '@crm/contracts';
import { EMAIL_BODY_MAX, EMAIL_TEMPLATE_NAME_MAX } from '@crm/core';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  MailIcon,
  PlusIcon,
  Skeleton,
  Textarea,
} from '@crm/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import {
  useCreateEmailTemplate,
  useDeleteEmailTemplate,
  useEmailTemplates,
  useUpdateEmailTemplate,
  type EmailTemplate,
} from '../lib/emails';
import { t } from '../lib/i18n';

/**
 * The company's email templates, on Settings > Email (ADR-0074).
 *
 * Reading them is for anyone who may send; changing them needs `tenant_settings`, answered by the API,
 * so this card only appears on a screen the API already let the person into. The four states are here:
 * loading, empty with the action that fills it, an error, and the lists themselves.
 */
type FormValues = z.input<typeof emailTemplateCreateSchema>;

export function EmailTemplatesPanel() {
  const query = useEmailTemplates();
  const [editing, setEditing] = useState<EmailTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<EmailTemplate | null>(null);
  const templates = query.data?.data ?? [];

  return (
    <Card data-testid="email-templates">
      <CardHeader
        title={t('email.templates.title')}
        description={t('email.templates.description')}
        actions={
          <Button size="sm" onClick={() => setEditing('new')} data-testid="email-template-new">
            <PlusIcon className="h-4 w-4" />
            {t('email.templates.new')}
          </Button>
        }
      />
      <CardBody>
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState
            compact
            title={t('email.templates.error.title')}
            description={t('email.error.description')}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : templates.length === 0 ? (
          <EmptyState
            compact
            icon={<MailIcon className="h-5 w-5" />}
            title={t('email.templates.empty.title')}
            description={t('email.templates.empty.description')}
            action={
              <Button size="sm" onClick={() => setEditing('new')}>
                {t('email.templates.empty.action')}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border" data-testid="email-template-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
                data-testid="email-template-row"
              >
                <div className="min-w-0">
                  <p className="font-medium">{template.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{template.subject}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(template)}>
                    {t('email.templates.edit')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(template)}>
                    {t('email.templates.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      {editing !== null ? (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteDialog template={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </Card>
  );
}

function TemplateDialog({
  template,
  onClose,
}: {
  template: EmailTemplate | null;
  onClose: () => void;
}) {
  const create = useCreateEmailTemplate();
  const update = useUpdateEmailTemplate(template?.id ?? '');
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(emailTemplateCreateSchema),
    defaultValues: {
      name: template?.name ?? '',
      subject: template?.subject ?? '',
      body: template?.body ?? '',
    },
  });

  const mutation = template === null ? create : update;
  const submit = handleSubmit((values) => {
    if (template === null) {
      create.mutate(values, { onSuccess: onClose });
    } else {
      update.mutate({ ...values, version: template.version }, { onSuccess: onClose });
    }
  });

  const failure =
    mutation.error === null
      ? null
      : mutation.error.status === 409 && mutation.error.code === 'VERSION_CONFLICT'
        ? t('email.templates.conflict')
        : mutation.error.status === 409
          ? mutation.error.message.includes('at most')
            ? t('email.templates.limit')
            : t('email.templates.nameTaken')
          : t('email.templates.saveError');

  const fieldError = (message: string | undefined): string | undefined =>
    message === undefined
      ? undefined
      : message.startsWith('Use only these fields')
        ? t('email.fields.unknown')
        : t('error.required');

  return (
    <Dialog
      title={template === null ? t('email.templates.new') : t('email.templates.edit')}
      closeLabel={t('common.close')}
      onClose={onClose}
      data-testid="email-template-dialog"
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
        <Input
          label={t('email.templates.name')}
          maxLength={EMAIL_TEMPLATE_NAME_MAX}
          aria-required="true"
          error={fieldError(errors.name?.message)}
          {...register('name')}
        />
        <Input
          label={t('email.templates.subject')}
          aria-required="true"
          error={fieldError(errors.subject?.message)}
          {...register('subject')}
        />
        <Textarea
          label={t('email.templates.body')}
          hint={t('email.fields.help')}
          rows={8}
          maxLength={EMAIL_BODY_MAX}
          aria-required="true"
          error={fieldError(errors.body?.message)}
          {...register('body')}
        />
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive" data-testid="email-template-error">
            {failure}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {t('email.templates.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ template, onClose }: { template: EmailTemplate; onClose: () => void }) {
  const remove = useDeleteEmailTemplate();
  return (
    <Dialog
      title={t('email.templates.delete.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <p className="text-sm">{t('email.templates.delete.body', { name: template.name })}</p>
      {remove.isError ? (
        <p role="alert" className="pt-2 text-sm text-destructive">
          {t('email.templates.delete.error')}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="ghost" onClick={onClose}>
          {t('field.cancel')}
        </Button>
        <Button
          loading={remove.isPending}
          onClick={() =>
            remove.mutate({ id: template.id, version: template.version }, { onSuccess: onClose })
          }
        >
          {t('email.templates.delete.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
