'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { emailBodySchema, emailSubjectSchema } from '@crm/contracts';
import {
  EMAIL_BODY_MAX,
  EMAIL_MERGE_FIELDS,
  EMAIL_SIGNATURE_MAX,
  emptyEmailMergeFields,
} from '@crm/core';
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
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { formatName } from '../lib/format';
import {
  useContactNames,
  useEmailContext,
  useEmailSignature,
  useEmailTemplates,
  useSaveEmailSignature,
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
  body: emailBodySchema,
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
    setValue,
    getValues,
    control,
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

  const templates = useEmailTemplates(context.data !== undefined);
  const [templateId, setTemplateId] = useState('');
  const [typedSubject, typedBody] = useWatch({ control, name: ['subject', 'body'] });
  const typed = `${typedSubject}\n${typedBody}`;

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

  const fieldError = (message: string | undefined): string | undefined =>
    message === undefined
      ? undefined
      : message.startsWith('Use only these fields')
        ? t('email.fields.unknown')
        : t('error.required');
  const emptyFields = emptyEmailMergeFields(typed, info.mergeValues);
  const templateList = templates.data?.data ?? [];

  const withdrawn = info.consent === 'withdrawn';
  // A blocked address or a paused company cannot be written to, and the screen says why before anything is typed.
  const blocked = info.suppressed !== null || info.paused;
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
        : send.error.code === 'EMAIL_PAUSED'
          ? t('email.paused.notice')
          : send.error.code === 'ADDRESS_SUPPRESSED'
            ? t('email.suppressed.hard_bounce')
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

      {info.paused ? (
        <p role="alert" className="text-sm text-destructive" data-testid="send-email-paused">
          {t('email.paused.notice')}
        </p>
      ) : null}
      {info.suppressed !== null ? (
        <p role="alert" className="text-sm text-destructive" data-testid="send-email-suppressed">
          {t(`email.suppressed.${info.suppressed.reason}`)}
        </p>
      ) : null}
      {withdrawn ? (
        <p role="alert" className="text-sm text-destructive">
          {t('email.dialog.consent.withdrawn')}
        </p>
      ) : info.consent === 'none' ? (
        <p className="text-sm text-muted-foreground">{t('email.dialog.consent.none')}</p>
      ) : null}

      {templateList.length > 0 ? (
        <Select
          label={t('email.template.pick')}
          value={templateId}
          onChange={(event) => {
            const picked = templateList.find((template) => template.id === event.target.value);
            setTemplateId(event.target.value);
            if (picked !== undefined) {
              setValue('subject', picked.subject, { shouldValidate: true });
              setValue('body', picked.body, { shouldValidate: true });
            }
          }}
        >
          <option value="">{t('email.template.none')}</option>
          {templateList.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      ) : null}

      <Input
        label={t('email.dialog.subject')}
        aria-required="true"
        error={fieldError(errors.subject?.message)}
        {...register('subject')}
      />

      <Textarea
        label={t('email.dialog.body')}
        hint={t('email.dialog.bodyHint')}
        rows={8}
        maxLength={EMAIL_BODY_MAX}
        aria-required="true"
        error={fieldError(errors.body?.message)}
        {...register('body')}
        onKeyDown={(event) => {
          // Ctrl or Cmd + Enter sends, as in every mail program.
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void submit();
        }}
      />

      <Select
        label={t('email.fields.insert')}
        hint={t('email.fields.help')}
        value=""
        onChange={(event) => {
          const field = event.target.value;
          if (field === '') return;
          // Added at the end of the message: the person moves it where it belongs.
          const body = getValues('body');
          setValue('body', `${body}${body === '' || body.endsWith(' ') ? '' : ' '}{{${field}}}`, {
            shouldValidate: true,
          });
        }}
      >
        <option value="">{t('email.fields.choose')}</option>
        {EMAIL_MERGE_FIELDS.map((field) => (
          <option key={field} value={field}>
            {t(`email.field.${field}`)}
          </option>
        ))}
      </Select>
      {emptyFields.length > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="send-email-empty-fields">
          {t('email.fields.empty', {
            fields: emptyFields.map((field) => t(`email.field.${field}`)).join(', '),
          })}
        </p>
      ) : null}

      <SignatureBlock signature={info.signature} />

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
        <Button
          type="submit"
          loading={send.isPending}
          disabled={withdrawn || reachedLimit || blocked}
        >
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

/**
 * The person's own signature: shown as it will be added, and editable here, because the sender is not
 * always somebody who can reach the settings screen (ADR-0074).
 */
function SignatureBlock({ signature }: { signature: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const current = useEmailSignature(editing);
  const save = useSaveEmailSignature();

  if (!editing) {
    return (
      <div className="text-sm" data-testid="send-email-signature">
        {signature.trim() === '' ? (
          <p className="text-muted-foreground">{t('email.signature.none')}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t('email.signature.added')}</p>
            <pre className="whitespace-pre-wrap font-sans">{signature}</pre>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setText(signature);
            setEditing(true);
          }}
        >
          {t('email.signature.edit')}
        </Button>
      </div>
    );
  }

  const version = current.data?.data.version;
  const failed =
    save.error === null
      ? null
      : save.error.status === 409
        ? t('email.signature.conflict')
        : t('email.signature.error');

  return (
    <div className="space-y-2" data-testid="send-email-signature-editor">
      <Textarea
        label={t('email.signature.title')}
        hint={t('email.signature.hint')}
        rows={3}
        maxLength={EMAIL_SIGNATURE_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {failed !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {failed}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          loading={save.isPending}
          disabled={current.data === undefined}
          onClick={() =>
            save.mutate(
              { text, ...(version === null || version === undefined ? {} : { version }) },
              { onSuccess: () => setEditing(false) },
            )
          }
        >
          {t('email.signature.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          {t('field.cancel')}
        </Button>
      </div>
    </div>
  );
}
