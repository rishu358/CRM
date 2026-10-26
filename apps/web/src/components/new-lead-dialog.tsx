'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, Input, Select } from '@crm/ui';
import { leadCreateSchema } from '@crm/contracts';
import { type z } from 'zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import { CustomFieldsFields, useCustomFieldDrafts } from './custom-fields';
import { useCheckDuplicates, type DuplicateMatch } from '../lib/leads';
import { DuplicateMatches } from './duplicate-matches';

/**
 * Create a lead.
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift. The server still validates: this is
 * for feedback, never for enforcement.
 *
 * Before saving, it asks the API whether what was typed matches anything the
 * person can already see, and if so shows the matches and lets them choose:
 * open one instead, go back and edit, or save anyway. It never blocks —
 * a person may genuinely have two leads at one company (MVP_SPEC M4, ADR-0023).
 * The check is a separate call from the save, so a failure of the check can
 * never lose someone's lead: if it errors, the save goes ahead.
 */
const formSchema = leadCreateSchema.pick({
  firstName: true,
  lastName: true,
  company: true,
  email: true,
  phone: true,
  source: true,
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

const SOURCES = ['referral', 'website', 'walk_in', 'exhibition', 'social', 'other'] as const;

export function NewLeadDialog({
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
  const check = useCheckDuplicates();
  const custom = useCustomFieldDrafts('lead');
  const [matches, setMatches] = useState<readonly DuplicateMatch[] | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  // Focus moves into the dialog on open and Escape closes it: a modal a
  // keyboard user cannot enter or leave is not usable (CLAUDE.md §9).
  useEffect(() => {
    setFocus('lastName');
  }, [setFocus]);

  const submit = handleSubmit(async (values) => {
    const body: Record<string, unknown> = { lastName: values.lastName };
    for (const key of ['firstName', 'company', 'email', 'phone', 'source'] as const) {
      const value = values[key];
      if (value !== undefined && value !== null && value !== '') body[key] = value;
    }
    const extra = custom.collect();
    if (extra === null) return;
    if (Object.keys(extra).length > 0) body['customFields'] = extra;

    const lookup: Record<string, unknown> = {};
    for (const key of ['email', 'phone', 'company'] as const) {
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
        // A failed look-up must not stand between a person and saving their
        // lead. The API reports matches again after the save regardless.
      }
    }
    onSubmit(body);
  });

  return (
    <Dialog
      title={matches !== null && payload !== null ? t('duplicate.title') : t('leads.new')}
      description={matches !== null && payload !== null ? t('duplicate.description') : undefined}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      {matches !== null && payload !== null ? (
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
          {/*
              noValidate: the browser's own validation bubble would pre-empt ours,
              and it cannot be styled, translated, or announced consistently. Zod
              owns validation here, and the messages render as role="alert".
            */}
          <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
            <Input
              label={t('lead.firstName')}
              {...register('firstName', { setValueAs: blankToUndefined })}
            />
            <Input
              label={t('lead.lastName')}
              aria-required="true"
              error={errors.lastName === undefined ? undefined : t('error.required')}
              {...register('lastName')}
            />
            <Input
              label={t('lead.company')}
              {...register('company', { setValueAs: blankToUndefined })}
            />
            <Input
              label={t('lead.email')}
              type="email"
              error={errors.email?.message}
              {...register('email', { setValueAs: blankToUndefined })}
            />
            <Input
              label={t('lead.phone')}
              hint="+919876543210"
              error={errors.phone?.message}
              {...register('phone', { setValueAs: blankToUndefined })}
            />
            <Select
              label={t('lead.source')}
              defaultValue=""
              {...register('source', { setValueAs: blankToUndefined })}
            >
              <option value="">{t('field.empty')}</option>
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source.replace('_', ' ')}
                </option>
              ))}
            </Select>

            <CustomFieldsFields state={custom} idPrefix="new-lead" />

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
