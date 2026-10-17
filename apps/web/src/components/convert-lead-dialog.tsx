'use client';

import { Button, Input, Skeleton } from '@crm/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t, type TranslationKey } from '../lib/i18n';
import {
  useConversionMatches,
  useConvertLead,
  type AccountChoice,
  type ContactChoice,
  type ConversionResult,
  type DuplicateMatch,
  type LeadRecord,
} from '../lib/leads';
import { formatName } from '../lib/format';

/**
 * Convert a lead into a contact, an account and, optionally, a deal
 * (MVP_SPEC M4, ADR-0022).
 *
 * The part this dialog exists for: it asks the API what converting would
 * duplicate **before** offering anything, and when there is a match it
 * pre-selects "link to existing" instead of "create". A person who just clicks
 * Convert therefore attaches the lead to the contact they already have rather
 * than minting a second one; creating a new record anyway is a deliberate
 * choice, made with the match on screen (ADR-0023).
 */
export function ConvertLeadDialog({ lead, onClose }: { lead: LeadRecord; onClose: () => void }) {
  const matchesQuery = useConversionMatches(lead.id);
  const convert = useConvertLead();

  const contactMatches = (matchesQuery.data?.data ?? []).filter((m) => m.objectType === 'contact');
  const accountMatches = (matchesQuery.data?.data ?? []).filter((m) => m.objectType === 'account');
  const company = lead.company ?? null;

  // `undefined` means "the person has not chosen", in which case the default
  // follows the matches as they arrive: link when there is something to link
  // to. Storing the default in state would freeze it before the matches load.
  const [contactChoice, setContactChoice] = useState<ContactChoice | undefined>();
  const [accountChoice, setAccountChoice] = useState<AccountChoice | undefined>();
  const [makeDeal, setMakeDeal] = useState(false);
  const [dealName, setDealName] = useState(
    `${company ?? lead.lastName ?? ''} — opportunity`.slice(0, 200),
  );
  const [result, setResult] = useState<ConversionResult | null>(null);

  const firstContact = contactMatches[0];
  const firstAccount = accountMatches[0];

  const effectiveContact: ContactChoice =
    contactChoice ??
    (firstContact === undefined
      ? { mode: 'create' }
      : { mode: 'link', contactId: firstContact.id });

  const effectiveAccount: AccountChoice =
    accountChoice ??
    (firstAccount !== undefined
      ? { mode: 'link', accountId: firstAccount.id }
      : company === null
        ? { mode: 'none' }
        : { mode: 'create' });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * Choosing "create" while a match exists is the person saying they have seen
   * it and want a separate record. That is what the API's acknowledgement
   * means, so it is sent only in that case.
   */
  const creatingDespiteMatch =
    (effectiveContact.mode === 'create' && contactMatches.length > 0) ||
    (effectiveAccount.mode === 'create' && accountMatches.length > 0);

  const submit = () => {
    convert.mutate(
      {
        id: lead.id,
        version: lead.version,
        contact: effectiveContact,
        account: effectiveAccount,
        dealName: makeDeal && dealName.trim().length > 0 ? dealName.trim() : null,
        acknowledgeDuplicates: creatingDespiteMatch,
      },
      {
        onSuccess: (response) => setResult(response.data),
        onError: (error) => {
          // A match appeared after this dialog loaded. Refresh the options so
          // the person chooses with the match on screen rather than retrying blind.
          if (error.code === 'DUPLICATE_RECORDS') {
            setContactChoice(undefined);
            setAccountChoice(undefined);
            void matchesQuery.refetch();
          }
        },
      },
    );
  };

  const errorMessage = (() => {
    const error = convert.error;
    if (error === null) return null;
    if (error.code === 'DUPLICATE_RECORDS') return t('convert.error.duplicate');
    if (error.code === 'VERSION_CONFLICT') return t('convert.error.changed');
    return error.message;
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-lead-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        {result !== null ? (
          <ConversionDone result={result} onClose={onClose} />
        ) : (
          <>
            <h2 id="convert-lead-title" className="mb-1 text-base font-semibold">
              {t('convert.title', { name: formatName(lead) || (lead.lastName ?? '') })}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">{t('convert.description')}</p>

            {matchesQuery.isPending ? (
              <div className="space-y-3" role="status" aria-label={t('convert.loadingMatches')}>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <div className="space-y-5">
                <Choice legend={t('convert.contact')}>
                  <Radio
                    name="contact"
                    label={t('convert.contact.create')}
                    checked={effectiveContact.mode === 'create'}
                    onChange={() => setContactChoice({ mode: 'create' })}
                  />
                  {contactMatches.map((match) => (
                    <Radio
                      key={match.id}
                      name="contact"
                      label={`${t('convert.contact.link')}: ${match.label}`}
                      hint={reasons(match)}
                      checked={
                        effectiveContact.mode === 'link' && effectiveContact.contactId === match.id
                      }
                      onChange={() => setContactChoice({ mode: 'link', contactId: match.id })}
                    />
                  ))}
                </Choice>

                <Choice legend={t('convert.account')}>
                  {company !== null ? (
                    <Radio
                      name="account"
                      label={t('convert.account.create', { company })}
                      checked={effectiveAccount.mode === 'create'}
                      onChange={() => setAccountChoice({ mode: 'create' })}
                    />
                  ) : null}
                  {accountMatches.map((match) => (
                    <Radio
                      key={match.id}
                      name="account"
                      label={`${t('convert.account.link')}: ${match.label}`}
                      hint={reasons(match)}
                      checked={
                        effectiveAccount.mode === 'link' && effectiveAccount.accountId === match.id
                      }
                      onChange={() => setAccountChoice({ mode: 'link', accountId: match.id })}
                    />
                  ))}
                  <Radio
                    name="account"
                    label={t('convert.account.none')}
                    checked={effectiveAccount.mode === 'none'}
                    onChange={() => setAccountChoice({ mode: 'none' })}
                  />
                </Choice>

                {creatingDespiteMatch ? (
                  <p
                    role="status"
                    className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
                  >
                    {t('convert.duplicateWarning')}
                  </p>
                ) : null}

                <fieldset className="space-y-2">
                  <legend className="mb-1 text-sm font-medium">{t('convert.deal')}</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={makeDeal}
                      onChange={(event) => setMakeDeal(event.target.checked)}
                    />
                    {t('convert.deal.create')}
                  </label>
                  {makeDeal ? (
                    <Input
                      label={t('convert.deal.name')}
                      value={dealName}
                      onChange={(event) => setDealName(event.target.value)}
                    />
                  ) : null}
                </fieldset>
              </div>
            )}

            {errorMessage !== null ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('field.cancel')}
              </Button>
              <Button
                type="button"
                loading={convert.isPending}
                disabled={matchesQuery.isPending}
                onClick={submit}
              >
                {t('convert.submit')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function reasons(match: DuplicateMatch): string {
  return match.matchedOn
    .map((reason) => t(`duplicate.reason.${reason}` as TranslationKey))
    .join(', ');
}

function Choice({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Radio({
  name,
  label,
  hint,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border p-2.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent/40">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5" />
      <span>
        {label}
        {hint !== undefined && hint.length > 0 ? (
          <span className="ml-2 text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

function ConversionDone({ result, onClose }: { result: ConversionResult; onClose: () => void }) {
  const rows: { label: string; href: string; state: string }[] = [
    {
      label: t('lead.converted.contact'),
      href: `/contacts/${result.contact.id}`,
      state: result.contact.created ? t('convert.done.created') : t('convert.done.linked'),
    },
  ];
  if (result.account !== null) {
    rows.push({
      label: t('lead.converted.account'),
      href: `/accounts/${result.account.id}`,
      state: result.account.created ? t('convert.done.created') : t('convert.done.linked'),
    });
  }
  if (result.deal !== null) {
    rows.push({
      label: t('lead.converted.deal'),
      href: `/deals/${result.deal.id}`,
      state: t('convert.done.created'),
    });
  }

  return (
    <div className="space-y-4" data-testid="conversion-done">
      <h2 id="convert-lead-title" className="text-base font-semibold">
        {t('convert.done.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('convert.done.description')}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between p-3 text-sm">
            <Link
              href={row.href}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {row.label}
            </Link>
            <span className="text-xs text-muted-foreground">{row.state}</span>
          </li>
        ))}
      </ul>
      {result.skippedFields.length > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('convert.done.skipped', { fields: result.skippedFields.join(', ') })}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" onClick={onClose}>
          {t('convert.done.close')}
        </Button>
      </div>
    </div>
  );
}
