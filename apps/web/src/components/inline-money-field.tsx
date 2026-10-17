'use client';

import { Button } from '@crm/ui';
import { fromMajorString, minorUnitExponent, toCurrency } from '@crm/core';
import { useEffect, useRef, useState } from 'react';
import type { MoneyValue } from '../lib/accounts';
import { DEFAULT_PREFERENCES, formatMoney } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * Edit an amount in place.
 *
 * Money needs its own control rather than a text `InlineField`, for one
 * reason: an amount is two values, and a control that edits only the number
 * would let somebody change ₹50,00,000 into $50,00,000 by changing nothing.
 *
 * The person types **major units** — 1500.75, what is printed on an invoice —
 * and what is sent is minor units. `fromMajorString` from @crm/core does that
 * conversion, the same function the rest of the system uses, so the browser
 * never multiplies by 100 in floating point and never decides for itself how
 * many decimal places a currency has (JPY has none, KWD has three).
 */
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;

/**
 * Fallback when the account has no amount yet.
 *
 * The tenant's `default_currency` is the right answer and it is not on the
 * session payload yet; until it is, this is the beachhead's currency
 * (MVP_SPEC §1) rather than a guess dressed up as one.
 */
const FALLBACK_CURRENCY = 'INR';

/**
 * Minor units back to the major-unit string a person would type.
 *
 * Done on the digits rather than by dividing, so an amount past 2^53 shows
 * the value that is stored rather than a rounded one. The scale comes from
 * @crm/core, which is the one place that knows JPY has no decimals.
 */
function toMajorString(value: MoneyValue): string {
  let scale: number;
  try {
    scale = minorUnitExponent(toCurrency(value.currency));
  } catch {
    return value.amountMinor;
  }

  const negative = value.amountMinor.startsWith('-');
  const digits = (negative ? value.amountMinor.slice(1) : value.amountMinor).padStart(
    scale + 1,
    '0',
  );
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function InlineMoneyField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: MoneyValue | null | undefined;
  onSave: (next: MoneyValue | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>(FALLBACK_CURRENCY);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEditing = () => {
    setAmount(value == null ? '' : toMajorString(value));
    setCurrency(value?.currency ?? FALLBACK_CURRENCY);
    setError(null);
    setEditing(true);
  };

  const commit = () => {
    const typed = amount.trim();
    if (typed.length === 0) {
      setEditing(false);
      if (value != null) onSave(null);
      return;
    }

    try {
      const parsed = fromMajorString(typed, currency);
      setEditing(false);
      setError(null);
      onSave({ amountMinor: parsed.amountMinor.toString(), currency: parsed.currency });
    } catch {
      // Kept open with the message, rather than silently discarding what they
      // typed — which is what an inline field that closes on error does.
      setError(t('error.amount'));
    }
  };

  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-2">
      <span className="pt-1.5 text-sm text-muted-foreground">{label}</span>

      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="account-revenue-amount">
            {t('account.amount')}
          </label>
          <input
            id="account-revenue-amount"
            ref={inputRef}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') setEditing(false);
            }}
            className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm"
          />
          <label className="sr-only" htmlFor="account-revenue-currency">
            {t('account.currency')}
          </label>
          <select
            id="account-revenue-currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={commit}>
            {t('field.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t('field.cancel')}
          </Button>
          {error === null ? null : (
            <p role="alert" className="w-full text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          aria-label={`${t('field.edit')}: ${label}`}
          className="min-h-8 w-full max-w-sm rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
        >
          {value == null ? (
            <span className="text-muted-foreground">{t('field.empty')}</span>
          ) : (
            // Formatted through the shared helper, so an Indian tenant sees
            // lakh/crore grouping without this component knowing about it.
            formatMoney(value.amountMinor, value.currency, DEFAULT_PREFERENCES)
          )}
        </button>
      )}
    </div>
  );
}
