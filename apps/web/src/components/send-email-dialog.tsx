'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { emailSubjectSchema } from '@crm/contracts';
import { EMAIL_BODY_MAX, isValidBody } from '@crm/core';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  NoPermissionState,
  Select,
  Skeleton,
  Textarea,
} from '@crm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { formatName } from '../lib/format';
import {
  useContactNames,
  useEmailContext,
  useSendEmail,
  type EmailSourceType,
} from '../lib/emails';
import { t } from '../lib/i18n';

/**
 * Write an email to the person a record is about (ADR-0073).
 *
 * The recipient is never typed here: the API reads it from the record, as the person asking, and the
 * dialog only shows it. The form validates against the same Zod pieces the API uses, for feedback; the
 * server decides. Every state a screen has is here: loading, an error, no permission, the feature off,
 * a record with no address, a person who has opted out, and the daily limit.
 */
const formSchema = z.object({
  subject: emailSubjectSchema,
  body: z.string().refine(isValidBody, { message: 'error.required' }),
});
type FormValues = z.input<typeof formSchema>;

export function SendEmailDialog({
  objectType,
  recordId,
  people,
  onClose,
}: {
  objectType: EmailSourceType;
  recordId: string;
  /** For a deal: the contacts it can be written to, the main one first. */
  people?: readonly string[];
  onClose: () => void;
}) {
  const isDeal = objectType === 'deal';
  const [chosen, setChosen] = useState<string | undefined>(people?.[0]);
  const contactId = isDeal ? chosen : undefined;
  const context = useEmailContext(
    objectType,
    recordId,
    contactId,
    !isDeal || contactId !== undefined,
  );
  const send = useSendEmail();
  // One key for this dialog: a double click, or a retry after a dropped connection, sends once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { subject: '', body: '' },
  });

  // Focus moves to the subject once the form is there, and Escape closes the dialog: a modal a keyboard
  // user cannot enter or leave is not usable (CLAUDE.md §9).
  const ready = context.data?.data.to != null;
  useEffect(() => {
    if (ready) setFocus('subject');
  }, [ready, setFocus]);

  const title = t('email.dialog.title');
  const shell = (children: React.ReactNode) => (
    <Dialog
      title={title}
      closeLabel={t('common.close')}
      onClose={onClose}
      data-testid="send-email-dialog"
    >
      {children}
    </Dialog>
  );

  if (isDeal && (people === undefined || people.length === 0)) {
    return shell(
      <EmptyState compact title={t('email.dialog.noContacts')} action={closeButton(onClose)} />,
    );
  }

  if (context.isError) {
    const status = context.error.status;
    return shell(
      status === 403 ? (
        <NoPermissionState
          compact
          title={t('email.forbidden.title')}
          description={t('email.forbidden.description')}
          action={closeButton(onClose)}
        />
      ) : status === 402 ? (
        <NoPermissionState
          compact
          title={t('email.disabled.title')}
          description={t('email.disabled.description')}
          action={closeButton(onClose)}
        />
      ) : (
        <ErrorState
          compact
          title={t('email.error.title')}
          description={t('email.error.description')}
          action={
            <Button variant="outline" size="sm" onClick={() => void context.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ),
    );
  }

  if (context.data === undefined) {
    return shell(
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>,
    );
  }

  const info = context.data.data;

  if (info.to === null) {
    return shell(
      <EmptyState
        compact
        title={t('email.dialog.noAddress.title')}
        description={t('email.dialog.noAddress.description')}
        action={closeButton(onClose)}
      />,
    );
  }

  const withdrawn = info.consent === 'withdrawn';
  const reachedLimit = info.usage.sentToday >= info.usage.limitPerUser;

  const submit = handleSubmit((values) => {
    send.mutate(
      {
        objectType,
        recordId,
        contactId,
        subject: values.subject,
        body: values.body,
        idempotencyKey,
      },
      { onSuccess: onClose },
    );
  });

  const errorText =
    send.error === null
      ? null
      : send.error.status === 429
        ? send.error.message.includes('too fast')
          ? t('email.dialog.tooFast')
          : t('email.dialog.limit')
        : send.error.code === 'CONSENT_WITHDRAWN'
          ? t('email.dialog.consent.withdrawn')
          : send.error.code === 'NO_EMAIL_ADDRESS'
            ? t('email.dialog.noAddress.title')
            : send.error.status === 403
              ? t('email.dialog.forbidden')
              : t('email.dialog.error');

  return shell(
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="space-y-4"
      data-testid="send-email-form"
    >
      {isDeal && people !== undefined && people.length > 1 ? (
        <PersonChoice people={people} value={chosen} onChange={setChosen} />
      ) : null}

      <div className="text-sm">
        <span className="text-muted-foreground">{t('email.dialog.to')}</span>{' '}
        <span className="font-medium" data-testid="send-email-to">
          {info.toName === null ? info.to : `${info.toName} <${info.to}>`}
        </span>
      </div>

      {withdrawn ? (
        <p role="alert" className="text-sm text-destructive">
          {t('email.dialog.consent.withdrawn')}
        </p>
      ) : info.consent === 'none' ? (
        <p className="text-sm text-muted-foreground">{t('email.dialog.consent.none')}</p>
      ) : null}

      <Input
        label={t('email.dialog.subject')}
        aria-required="true"
        error={errors.subject === undefined ? undefined : t('error.required')}
        {...register('subject')}
      />

      <Textarea
        label={t('email.dialog.body')}
        hint={t('email.dialog.bodyHint')}
        rows={8}
        maxLength={EMAIL_BODY_MAX}
        aria-required="true"
        error={errors.body === undefined ? undefined : t('error.required')}
        {...register('body')}
        onKeyDown={(event) => {
          // Ctrl or Cmd + Enter sends, as in every mail program.
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void submit();
        }}
      />

      <p className="text-sm text-muted-foreground">
        {t('email.dialog.sentAs', { name: info.fromName, address: info.replyTo })}
      </p>
      {!info.senderConfigured ? (
        <p className="text-sm text-muted-foreground">{t('email.dialog.notSetUp')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid="send-email-usage">
        {t('email.dialog.usage', { sent: info.usage.sentToday, limit: info.usage.limitPerUser })}
      </p>
      {reachedLimit ? (
        <p role="alert" className="text-sm text-destructive">
          {t('email.dialog.limit')}
        </p>
      ) : null}

      {errorText !== null ? (
        <p role="alert" className="text-sm text-destructive" data-testid="send-email-error">
          {errorText}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('field.cancel')}
        </Button>
        <Button type="submit" loading={send.isPending} disabled={withdrawn || reachedLimit}>
          {t('email.dialog.send')}
        </Button>
      </div>
    </form>,
  );
}

function closeButton(onClose: () => void) {
  return (
    <Button variant="outline" size="sm" onClick={onClose}>
      {t('common.close')}
    </Button>
  );
}

/** Which of a deal's people the email is written to. Names come through the contacts cache. */
function PersonChoice({
  people,
  value,
  onChange,
}: {
  people: readonly string[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const names = useContactNames(people);
  return (
    <Select
      label={t('email.dialog.writeTo')}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
    >
      {people.map((id, index) => {
        const record = names[index]?.data?.data;
        const name = record === undefined ? '' : formatName(record);
        return (
          <option key={id} value={id}>
            {name === '' ? t('email.dialog.writeTo') : name}
          </option>
        );
      })}
    </Select>
  );
}
