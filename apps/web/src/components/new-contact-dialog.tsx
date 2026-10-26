'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, Input } from '@crm/ui';
import { contactCreateSchema } from '@crm/contracts';
import { type z } from 'zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import { useCheckContactDuplicates } from '../lib/contacts';
import type { DuplicateMatch } from '../lib/leads';
import { CustomFieldsFields, useCustomFieldDrafts } from './custom-fields';
import { DuplicateMatches } from './duplicate-matches';

/**
 * Create a contact.
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift and a client-side pass means the
 * server will agree about shape. The server still validates: this is for
 * feedback, never for enforcement.
 *
 * Before saving, it asks the API whether the e-mail or phone typed matches a contact the person
 * can already see, and if so shows the match and lets them open it, go back and edit, or save
 * anyway. It never blocks (MVP_SPEC M4, ADR-0023). The check is a separate call from the save, so a
 * failure of the check can never lose someone's contact: if it errors, the save goes ahead.
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
  const check = useCheckContactDuplicates();
  const custom = useCustomFieldDrafts('contact');
  const [matches, setMatches] = useState<readonly DuplicateMatch[] | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
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

  const submit = handleSubmit(async (values) => {
    const body: Record<string, unknown> = { lastName: values.lastName };
    if (values.firstName !== undefined && values.firstName !== '') {
      body['firstName'] = values.firstName;
    }
    if (values.email !== undefined && values.email !== '') body['email'] = values.email;
    if (values.phone !== undefined && values.phone !== '') body['phone'] = values.phone;
    const extra = custom.collect();
    if (extra === null) return;
    if (Object.keys(extra).length > 0) body['customFields'] = extra;

    const lookup: Record<string, unknown> = {};
    for (const key of ['email', 'phone'] as const) {
      if (body[key] !== undefined) lookup[key] = body[key];
    }
    if (Object.keys(lookup).length > 0) {
      try {
        const found = (await check.mutateAsync(lookup)).data;
        if (found.length > 0) {
          setPayload(body);
          setMatches(found);
          return;
        }
      } catch {
        // A failed look-up must not stand between a person and saving their contact. The API
        // reports matches again after the save regardless.
      }
    }
    onSubmit(body);
  });

  const showPrompt = matches !== null && payload !== null;

  return (
    <Dialog
      title={showPrompt ? t('duplicate.title') : t('contacts.new')}
      description={showPrompt ? t('duplicate.description') : undefined}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      {showPrompt ? (
        <div className="space-y-4" data-testid="duplicate-prompt">
          <DuplicateMatches matches={matches} />

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setMatches(null)}>
              {t('duplicate.back')}
            </Button>
            <Button type="button" loading={pending} onClick={() => onSubmit(payload)}>
              {t('duplicate.createAnyway')}
            </Button>
          </div>
        </div>
      ) : (
        <>
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

            <CustomFieldsFields state={custom} idPrefix="new-contact" />

            {error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('field.cancel')}
              </Button>
              <Button type="submit" loading={pending || check.isPending}>
                {t('field.save')}
              </Button>
            </div>
          </form>
        </>
      )}
    </Dialog>
  );
}
