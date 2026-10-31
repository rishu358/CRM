'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { emailSettingsUpdateSchema } from '@crm/contracts';
import { EMAIL_FOOTER_MAX, EMAIL_FROM_NAME_MAX } from '@crm/core';
import {
  Button,
  Card,
  CardBody,
  ErrorState,
  Input,
  NoPermissionState,
  PageHeader,
  Skeleton,
  Textarea,
} from '@crm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useEmailSettings, useSaveEmailSettings, type EmailSettings } from '../lib/emails';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';
import { EmailTemplatesPanel } from './email-templates-panel';

/**
 * Settings, Email: the name the company's emails are sent under, where replies go, and a footer
 * (ADR-0073).
 *
 * Whether the person may be here is the API's answer (a 403 on the read, which needs `tenant_settings`),
 * never a guess from a role name; hiding the nav link is cosmetic. The address mail is sent from is shown
 * and cannot be changed here: it belongs to whoever runs the installation.
 */
const formSchema = z.object({
  fromName: emailSettingsUpdateSchema.shape.fromName,
  // The form holds text; an empty box means "none", which the API wants as null.
  replyTo: z.string().trim(),
  footerText: z.string().max(EMAIL_FOOTER_MAX),
});
type FormValues = z.input<typeof formSchema>;

export function EmailSettingsScreen() {
  const query = useEmailSettings();
  const header = (
    <PageHeader title={t('email.settings.title')} description={t('email.settings.description')} />
  );

  if (query.isPending) {
    return (
      <AppShell>
        {header}
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-24 w-full max-w-md" />
        </div>
      </AppShell>
    );
  }

  if (query.isError) {
    const status = query.error.status;
    return (
      <AppShell>
        {header}
        {status === 403 || status === 402 ? (
          <NoPermissionState
            title={status === 402 ? t('email.disabled.title') : t('email.settings.forbidden.title')}
            description={
              status === 402
                ? t('email.disabled.description')
                : t('email.settings.forbidden.description')
            }
          />
        ) : (
          <ErrorState
            title={t('email.settings.loadError.title')}
            description={t('email.settings.loadError.description')}
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

  return (
    <AppShell>
      {header}
      <SettingsForm settings={query.data.data} />
      <div className="mt-6">
        <EmailTemplatesPanel />
      </div>
    </AppShell>
  );
}

function SettingsForm({ settings }: { settings: EmailSettings }) {
  const save = useSaveEmailSettings();
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      fromName: settings.fromName,
      replyTo: settings.replyTo ?? '',
      footerText: settings.footerText ?? '',
    },
  });

  // A save, or a change by someone else, brings new values; the form follows them.
  useEffect(() => {
    reset({
      fromName: settings.fromName,
      replyTo: settings.replyTo ?? '',
      footerText: settings.footerText ?? '',
    });
  }, [settings, reset]);

  const submit = handleSubmit((values) => {
    setSaved(false);
    save.mutate(
      {
        fromName: values.fromName,
        replyTo: values.replyTo === '' ? null : values.replyTo,
        footerText: values.footerText.trim() === '' ? null : values.footerText,
        ...(settings.version === null ? {} : { version: settings.version }),
      },
      { onSuccess: () => setSaved(true) },
    );
  });

  const usage = settings.usage;

  return (
    <Card>
      <CardBody>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="max-w-xl space-y-4"
          data-testid="email-settings-form"
        >
          <div className="text-sm" data-testid="email-sending-address">
            <span className="text-muted-foreground">{t('email.settings.sendingAddress')}</span>{' '}
            <span className="font-medium">
              {settings.sendingAddress ?? t('email.settings.sendingAddress.none')}
            </span>
            <p className="mt-0.5 text-muted-foreground">
              {t('email.settings.sendingAddress.hint')}
            </p>
          </div>

          <Input
            label={t('email.settings.fromName')}
            hint={t('email.settings.fromName.hint')}
            maxLength={EMAIL_FROM_NAME_MAX}
            aria-required="true"
            error={errors.fromName === undefined ? undefined : t('email.settings.error')}
            {...register('fromName')}
          />
          <Input
            label={t('email.settings.replyTo')}
            hint={t('email.settings.replyTo.hint')}
            type="email"
            error={errors.replyTo === undefined ? undefined : t('email.settings.error')}
            {...register('replyTo')}
          />
          <Textarea
            label={t('email.settings.footer')}
            hint={t('email.settings.footer.hint')}
            rows={4}
            maxLength={EMAIL_FOOTER_MAX}
            error={errors.footerText === undefined ? undefined : t('email.settings.error')}
            {...register('footerText')}
          />

          <p className="text-sm text-muted-foreground">
            {t('email.settings.usage', {
              sent: usage.sentToday,
              limit: usage.limitPerUser,
              company: usage.tenantSentToday,
              companyLimit: usage.limitPerTenant,
            })}
          </p>

          {save.isError ? (
            <p role="alert" className="text-sm text-destructive" data-testid="email-settings-error">
              {save.error.status === 409 ? t('email.settings.conflict') : t('email.settings.error')}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-sm text-success" data-testid="email-settings-saved">
              {t('email.settings.saved')}
            </p>
          ) : null}

          <Button type="submit" loading={save.isPending}>
            {t('email.settings.save')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
