'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@crm/ui';
import { contactCreateSchema } from '@crm/contracts';
import { type z } from 'zod';
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';

/**
 * Create a contact.
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift and a client-side pass means the
 * server will agree about shape. The server still validates: this is for
 * feedback, never for enforcement.
 */
/**
 * Derived from the shared schema rather than declared separately, so the form's
 * type and the validator cannot drift apart (CLAUDE.md §9).
 */
const formSchema = contactCreateSchema.pick({
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
});

type FormValues = z.input<typeof formSchema>;

/**
 * An untouched optional input yields `''`, which is not a valid email or phone
 * number and not nullish either, so the shared schema rightly rejects it. Map
 * blanks to "not supplied" instead of loosening the schema — the schema is
 * shared with the API and must keep meaning the same thing on both sides.
 */
function blankToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === '' ? undefined : (value as string);
}

export function NewContactDialog({
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
  });

  // Focus moves into the dialog on open and Escape closes it: a modal a
  // keyboard user cannot enter or leave is not usable (CLAUDE.md §9).
  useEffect(() => {
    setFocus('lastName');
  }, [setFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = { lastName: values.lastName };
    if (values.firstName !== undefined && values.firstName !== '') {
      payload['firstName'] = values.firstName;
    }
    if (values.email !== undefined && values.email !== '') payload['email'] = values.email;
    if (values.phone !== undefined && values.phone !== '') payload['phone'] = values.phone;
    onSubmit(payload);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-contact-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 id="new-contact-title" className="mb-4 text-base font-semibold">
          {t('contacts.new')}
        </h2>

        {/*
          noValidate: the browser's own validation bubble would pre-empt ours,
          and it cannot be styled, translated, or announced consistently. Zod
          owns validation here, and the messages render as role="alert".
        */}
        <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
          <Input
            label={t('contact.firstName')}
            {...register('firstName', { setValueAs: blankToUndefined })}
          />
          <Input
            label={t('contact.lastName')}
            aria-required="true"
            error={errors.lastName === undefined ? undefined : t('error.required')}
            {...register('lastName')}
          />
          <Input
            label={t('contact.email')}
            type="email"
            error={errors.email?.message}
            {...register('email', { setValueAs: blankToUndefined })}
          />
          <Input
            label={t('contact.phone')}
            hint="+919876543210"
            error={errors.phone?.message}
            {...register('phone', { setValueAs: blankToUndefined })}
          />

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
