'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, Input, Select } from '@crm/ui';
import { dealCreateSchema } from '@crm/contracts';
import { fromMajorString } from '@crm/core';
import { z } from 'zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';
import { CustomFieldsFields, useCustomFieldDrafts } from './custom-fields';

/**
 * Create a deal.
 *
 * The form validates against **the same Zod schema the API uses**
 * (CLAUDE.md §9), so the two cannot drift. Three fields, not twelve: a deal
 * needs a name, and most of the time an amount and a date; the account, the
 * people and the rest are filled in on the record page, where they are
 * visible beside everything else.
 *
 * The amount is typed in **major units** — 1500.75, what is on the quote — and
 * converted by `fromMajorString` from @crm/core, which is the one function that
 * knows a yen has no decimals and a dinar has three. The browser never
 * multiplies by 100 in floating point.
 */
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;

const formSchema = dealCreateSchema
  .pick({ name: true, expectedCloseDate: true })
  .extend({ amountText: z.string().optional(), currency: z.string() });

type FormValues = z.input<typeof formSchema>;

/** An untouched optional input yields `''`, which is "not supplied", not an error. */
function blankToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === '' ? undefined : (value as string);
}

export function NewDealDialog({
  pipelineId,
  defaultCurrency,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  pipelineId: string;
  defaultCurrency: string;
  pending: boolean;
  error: ApiRequestError | null;
  onSubmit: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const custom = useCustomFieldDrafts('deal');
  const {
    register,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currency: defaultCurrency },
  });

  // Focus moves into the dialog on open and Escape closes it (CLAUDE.md §9).
  useEffect(() => {
    setFocus('name');
  }, [setFocus]);

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = { name: values.name, pipelineId };

    const typed = values.amountText?.trim() ?? '';
    if (typed.length > 0) {
      try {
        const amount = fromMajorString(typed, values.currency);
        payload['amount'] = {
          amountMinor: amount.amountMinor.toString(),
          currency: values.currency,
        };
      } catch {
        setError('amountText', { message: t('error.amount') });
        return;
      }
    }
    if (values.expectedCloseDate !== undefined && values.expectedCloseDate !== null) {
      payload['expectedCloseDate'] = values.expectedCloseDate;
    }
    const extra = custom.collect();
    if (extra === null) return;
    if (Object.keys(extra).length > 0) payload['customFields'] = extra;
    onSubmit(payload);
  });

  return (
    <Dialog title={t('deals.new')} closeLabel={t('common.close')} onClose={onClose}>
      {/* noValidate: Zod owns validation, and its messages render as role="alert". */}
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
        <Input
          label={t('deal.name')}
          aria-required="true"
          error={errors.name === undefined ? undefined : t('error.required')}
          {...register('name')}
        />

        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Input
            label={t('deal.amount')}
            inputMode="decimal"
            hint="1500.75"
            error={errors.amountText?.message}
            {...register('amountText')}
          />
          <Select id="new-deal-currency" label={t('deal.currency')} {...register('currency')}>
            {[...new Set([defaultCurrency, ...CURRENCIES])].map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </div>

        <Input
          label={t('deal.expectedCloseDate')}
          type="date"
          error={errors.expectedCloseDate === undefined ? undefined : t('deal.error.date')}
          {...register('expectedCloseDate', { setValueAs: blankToUndefined })}
        />

        <CustomFieldsFields state={custom} idPrefix="new-deal" />

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
