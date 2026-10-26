'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, Input } from '@crm/ui';
import { accountCreateSchema } from '@crm/contracts';
import { type z } from 'zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import { CustomFieldsFields, useCustomFieldDrafts } from './custom-fields';

/**
 * Create an account.
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift and a client-side pass means the
 * server will agree about shape. The server still validates: this is for
 * feedback, never for enforcement.
 *
 * Four fields, not eleven. Creating an account should take one line of typing;
 * GSTIN, addresses, revenue and the parent company are all things somebody
 * fills in later on the record page, and a dialog that asks for them up front
 * is a dialog people avoid.
 */
const formSchema = accountCreateSchema.pick({
  name: true,
  domain: true,
  email: true,
  phone: true,
});

type FormValues = z.input<typeof formSchema>;

/**
 * An untouched optional input yields `''`, which is not a valid domain or
 * email and not nullish either, so the shared schema rightly rejects it. Map
 * blanks to "not supplied" instead of loosening the schema — the schema is
 * shared with the API and must keep meaning the same thing on both sides.
 */
function blankToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === '' ? undefined : (value as string);
}

export function NewAccountDialog({
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
  const custom = useCustomFieldDrafts('account');
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
    setFocus('name');
  }, [setFocus]);

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = { name: values.name };
    for (const key of ['domain', 'email', 'phone'] as const) {
      const value = values[key];
      if (value !== undefined && value !== null && value !== '') payload[key] = value;
    }
    const extra = custom.collect();
    if (extra === null) return;
    if (Object.keys(extra).length > 0) payload['customFields'] = extra;
    onSubmit(payload);
  });

  return (
    <Dialog title={t('accounts.new')} closeLabel={t('common.close')} onClose={onClose}>
      {/*
          noValidate: the browser's own validation bubble would pre-empt ours,
          and it cannot be styled, translated, or announced consistently. Zod
          owns validation here, and the messages render as role="alert".
        */}
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
        <Input
          label={t('account.name')}
          aria-required="true"
          error={errors.name === undefined ? undefined : t('error.required')}
          {...register('name')}
        />
        <Input
          label={t('account.domain')}
          hint="acme.example"
          error={errors.domain?.message}
          {...register('domain', { setValueAs: blankToUndefined })}
        />
        <Input
          label={t('account.email')}
          type="email"
          error={errors.email?.message}
          {...register('email', { setValueAs: blankToUndefined })}
        />
        <Input
          label={t('account.phone')}
          hint="+919876543210"
          error={errors.phone?.message}
          {...register('phone', { setValueAs: blankToUndefined })}
        />

        <CustomFieldsFields state={custom} idPrefix="new-account" />

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
    </Dialog>
  );
}
