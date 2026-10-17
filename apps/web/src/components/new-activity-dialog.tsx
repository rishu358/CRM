'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, Select } from '@crm/ui';
import { activityCreateSchema } from '@crm/contracts';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { type z } from 'zod';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';

/**
 * Log a task, call, meeting or note against a record (MVP_SPEC M6).
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift. The server still validates: this
 * is for feedback, never for enforcement — and in particular the body is
 * sanitized server-side, because a browser cannot be the thing that decides
 * what markup is safe (ADR-0024).
 */
const formSchema = activityCreateSchema.pick({
  type: true,
  subject: true,
  body: true,
  priority: true,
});

type FormValues = z.input<typeof formSchema>;

/** A `datetime-local` value is wall-clock with no zone; the browser's own. */
function toInstant(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function NewActivityDialog({
  pending,
  error,
  onSubmit,
  onClose,
}: {
  pending: boolean;
  error: ApiRequestError | null;
  onSubmit: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    setFocus,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { type: 'task', priority: 'normal' },
  });

  // Focus moves into the dialog on open and Escape closes it: a modal a
  // keyboard user cannot enter or leave is not usable (CLAUDE.md §9).
  useEffect(() => {
    setFocus('subject');
  }, [setFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const type = watch('type');

  const submit = handleSubmit((values, event) => {
    const form = event?.target as HTMLFormElement | undefined;
    const dueInput = form?.elements.namedItem('dueAt') as HTMLInputElement | null;

    const payload: Record<string, unknown> = {
      type: values.type,
      subject: values.subject,
      priority: values.priority,
    };
    if (typeof values.body === 'string' && values.body.trim() !== '') payload['body'] = values.body;

    // A note has nothing to be due, and the API refuses one — so the field
    // is not offered for a note rather than being sent and rejected.
    const dueAt = dueInput === null ? undefined : toInstant(dueInput.value);
    if (values.type !== 'note' && dueAt !== undefined) payload['dueAt'] = dueAt;

    onSubmit(payload);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-activity-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 id="new-activity-title" className="mb-4 text-base font-semibold">
          {t('activities.new')}
        </h2>

        <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
          <Select label={t('activities.field.type')} {...register('type')}>
            <option value="task">{t('activities.type.task')}</option>
            <option value="call">{t('activities.type.call')}</option>
            <option value="meeting">{t('activities.type.meeting')}</option>
            <option value="note">{t('activities.type.note')}</option>
          </Select>

          <Input
            label={t('activities.field.subject')}
            aria-required="true"
            error={errors.subject === undefined ? undefined : t('error.required')}
            {...register('subject')}
          />

          {type !== 'note' ? (
            <Input label={t('activities.field.dueAt')} type="datetime-local" name="dueAt" />
          ) : null}

          <Select label={t('activities.field.priority')} {...register('priority')}>
            <option value="low">{t('activities.priority.low')}</option>
            <option value="normal">{t('activities.priority.normal')}</option>
            <option value="high">{t('activities.priority.high')}</option>
          </Select>

          <Input label={t('activities.field.body')} {...register('body')} />

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('field.cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {t('field.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
