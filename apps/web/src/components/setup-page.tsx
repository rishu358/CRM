'use client';

import { INDUSTRIES, type Industry, type TenantProfileUpdateInput } from '@crm/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Dialog,
  DialogFooter,
  ErrorState,
  Input,
  NoPermissionState,
  PageHeader,
  Select,
  Skeleton,
  Spinner,
} from '@crm/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError } from '../lib/api-client';
import {
  useCompleteSetup,
  useLoadSampleData,
  useOnboarding,
  useRemoveSampleData,
  useTenantProfile,
  useUpdateProfile,
  type OnboardingStatus,
  type TenantProfile,
} from '../lib/onboarding';
import { t, type TranslationKey } from '../lib/i18n';
import { SetupChecklist } from './setup-checklist';

/**
 * Company setup (MVP_SPEC M2).
 *
 * One route, two moods. Until setup is finished it is a short welcome: tell us
 * about the company, choose whether to start with sample data, done. After that
 * it is a settings page: the getting-started list, the company's details, and
 * the sample data with the means to add or remove it.
 *
 * Nothing here decides who may use it. Both reads are behind
 * `tenant_settings:read`, so for anybody else they fail with a 403 and the page
 * says so; every write is refused by the API in the same way regardless of what
 * this file shows.
 */
export function SetupPage() {
  const status = useOnboarding();
  const profile = useTenantProfile();

  const forbidden = status.error?.status === 403 || profile.error?.status === 403;

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl">
        <NoPermissionState
          title={t('setup.forbidden.title')}
          description={t('setup.forbidden.description')}
        />
      </div>
    );
  }

  if (status.isError || profile.isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState
          title={t('setup.error.title')}
          description={t('setup.error.description')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void status.refetch();
                void profile.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        />
      </div>
    );
  }

  if (status.isPending || profile.isPending) {
    return (
      <div role="status" aria-label={t('setup.loading')} className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-72" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  const state = status.data.data;
  const company = profile.data.data;

  return state.setupCompleted ? (
    <SettingsView status={state} profile={company} />
  ) : (
    <FirstRun profile={company} />
  );
}

// ---------------------------------------------------------------------------
// The company form, shared by both moods
// ---------------------------------------------------------------------------

interface CompanyForm {
  name: string;
  defaultCurrency: string;
  timezone: string;
  industry: Industry | '';
}

/**
 * One label per industry, as a record keyed by the contract's own type: add an
 * industry to the contract and this stops compiling until it has a label. (It is
 * not built from a template string, which could not say so — and "other" would
 * collide with the `.other` suffix the plural helper reserves.)
 */
const INDUSTRY_LABELS: Readonly<Record<Industry, TranslationKey>> = {
  retail: 'setup.industry.retail',
  wholesale: 'setup.industry.wholesale',
  manufacturing: 'setup.industry.manufacturing',
  services: 'setup.industry.services',
  real_estate: 'setup.industry.real_estate',
  education: 'setup.industry.education',
  healthcare: 'setup.industry.healthcare',
  technology: 'setup.industry.technology',
  hospitality: 'setup.industry.hospitality',
  other: 'setup.industry.somethingElse',
};

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function formFrom(profile: TenantProfile, preferredTimeZone: string | null = null): CompanyForm {
  return {
    name: profile.name,
    defaultCurrency: profile.defaultCurrency,
    timezone:
      preferredTimeZone !== null && supportedTimeZones().includes(preferredTimeZone)
        ? preferredTimeZone
        : profile.timezone,
    industry: profile.industry ?? '',
  };
}

/** Only what differs from what is stored: re-saving the same thing changes nothing. */
function changesFrom(profile: TenantProfile, form: CompanyForm): TenantProfileUpdateInput {
  const next: TenantProfileUpdateInput = {};
  const name = form.name.trim();
  if (name !== profile.name) next.name = name;
  if (form.defaultCurrency !== profile.defaultCurrency) next.defaultCurrency = form.defaultCurrency;
  if (form.timezone !== profile.timezone) next.timezone = form.timezone;
  const industry = form.industry === '' ? null : form.industry;
  if (industry !== profile.industry) next.industry = industry;
  return next;
}

const COMMON_CURRENCIES = [
  'INR',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SGD',
  'AUD',
  'CAD',
  'JPY',
  'CNY',
  'CHF',
  'SAR',
  'ZAR',
  'NZD',
  'HKD',
  'MYR',
  'THB',
  'IDR',
  'BDT',
  'LKR',
  'NPR',
  'QAR',
  'KWD',
  'OMR',
  'BHD',
] as const;

function currencyLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'currency' }).of(code);
    return name === undefined || name === code ? code : `${name} (${code})`;
  } catch {
    return code;
  }
}

function currencyOptions(current: string): string[] {
  return COMMON_CURRENCIES.includes(current as (typeof COMMON_CURRENCIES)[number])
    ? [...COMMON_CURRENCIES]
    : [current, ...COMMON_CURRENCIES];
}

function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

function timeZoneOptions(current: string): string[] {
  const zones = supportedTimeZones();
  return zones.includes(current) ? zones : [current, ...zones];
}

function CompanyFields({
  form,
  onChange,
  disabled,
  nameError,
}: {
  form: CompanyForm;
  onChange: (next: CompanyForm) => void;
  disabled: boolean;
  nameError?: string | undefined;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Input
        label={t('setup.field.name')}
        value={form.name}
        onChange={(event) => onChange({ ...form, name: event.target.value })}
        maxLength={120}
        autoComplete="organization"
        disabled={disabled}
        error={nameError}
        wrapperClassName="sm:col-span-2"
        data-testid="setup-name"
      />
      <Select
        label={t('setup.field.currency')}
        hint={t('setup.field.currency.hint')}
        value={form.defaultCurrency}
        onChange={(event) => onChange({ ...form, defaultCurrency: event.target.value })}
        disabled={disabled}
        data-testid="setup-currency"
      >
        {currencyOptions(form.defaultCurrency).map((code) => (
          <option key={code} value={code}>
            {currencyLabel(code)}
          </option>
        ))}
      </Select>
      <Select
        label={t('setup.field.timezone')}
        hint={t('setup.field.timezone.hint')}
        value={form.timezone}
        onChange={(event) => onChange({ ...form, timezone: event.target.value })}
        disabled={disabled}
        data-testid="setup-timezone"
      >
        {timeZoneOptions(form.timezone).map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </Select>
      <div className="sm:col-span-2">
        <Select
          label={t('setup.field.industry')}
          value={form.industry}
          onChange={(event) => onChange({ ...form, industry: event.target.value as Industry | '' })}
          disabled={disabled}
          data-testid="setup-industry"
        >
          <option value="">{t('setup.field.industry.none')}</option>
          {INDUSTRIES.map((industry) => (
            <option key={industry} value={industry}>
              {t(INDUSTRY_LABELS[industry])}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

function FirstRun({ profile }: { profile: TenantProfile }) {
  const router = useRouter();
  const update = useUpdateProfile();
  const load = useLoadSampleData();
  const complete = useCompleteSetup();

  const [form, setForm] = useState<CompanyForm>(() => formFrom(profile, browserTimeZone()));
  const [withSample, setWithSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (form.name.trim().length === 0) {
      setNameError(t('setup.field.name.required'));
      return;
    }
    setNameError(undefined);
    setBusy(true);

    try {
      const patch = changesFrom(profile, form);
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
    } catch {
      setError('setup.error.save');
      setBusy(false);
      return;
    }

    if (withSample) {
      try {
        await load.mutateAsync();
      } catch (cause) {
        // Already there is not a failure: the goal — sample data present — is met.
        if (!(cause instanceof ApiRequestError && cause.status === 409)) {
          // Loading is all-or-nothing, so trying again is safe. The details are
          // already saved; stop here so the person can retry or skip.
          setError('setup.error.sample');
          setBusy(false);
          return;
        }
      }
    }

    try {
      await complete.mutateAsync();
      router.push('/dashboard');
    } catch {
      setError('setup.error.save');
      setBusy(false);
    }
  };

  const skip = async () => {
    setError(null);
    setBusy(true);
    try {
      await complete.mutateAsync();
      router.push('/dashboard');
    } catch {
      setError('setup.error.save');
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={t('setup.welcome.title', { company: profile.name })}
        description={t('setup.welcome.description')}
        className="mb-5"
      />

      <form onSubmit={(event) => void finish(event)} noValidate className="space-y-5">
        <Card>
          <CardHeader
            title={t('setup.company.title')}
            description={t('setup.company.description')}
          />
          <CardBody>
            <CompanyFields form={form} onChange={setForm} disabled={busy} nameError={nameError} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t('setup.sample.title')} />
          <CardBody>
            <Checkbox
              label={t('setup.sample.start')}
              description={t('setup.sample.startHint')}
              checked={withSample}
              onChange={(event) => setWithSample(event.target.checked)}
              disabled={busy}
              data-testid="setup-sample"
            />
          </CardBody>
        </Card>

        {error === null ? null : (
          <p
            role="alert"
            className="text-sm font-medium text-destructive"
            data-testid="setup-error"
          >
            {t(error)}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy} data-testid="setup-finish">
            {busy ? t('setup.finishing') : t('setup.finish')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void skip()}
            data-testid="setup-skip"
          >
            {t('setup.skip')}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// After setup: the settings page
// ---------------------------------------------------------------------------

function SettingsView({ status, profile }: { status: OnboardingStatus; profile: TenantProfile }) {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('setup.title')} description={t('setup.description')} className="mb-5" />
      <div className="space-y-5">
        <SetupChecklist checklist={status.checklist} />
        <CompanyCard profile={profile} />
        <SampleDataCard status={status} />
      </div>
    </div>
  );
}

function CompanyCard({ profile }: { profile: TenantProfile }) {
  const update = useUpdateProfile();
  const [form, setForm] = useState<CompanyForm>(() => formFrom(profile));
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const patch = changesFrom(profile, form);
  const dirty = Object.keys(patch).length > 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setFailed(false);
    if (form.name.trim().length === 0) {
      setNameError(t('setup.field.name.required'));
      return;
    }
    setNameError(undefined);
    try {
      const result = await update.mutateAsync(patch);
      setForm(formFrom(result.data));
      setSaved(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <Card>
      <CardHeader title={t('setup.company.title')} description={t('setup.company.description')} />
      <CardBody>
        <form onSubmit={(event) => void save(event)} noValidate className="space-y-4">
          <CompanyFields
            form={form}
            onChange={(next) => {
              setSaved(false);
              setForm(next);
            }}
            disabled={update.isPending}
            nameError={nameError}
          />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={!dirty}
              loading={update.isPending}
              data-testid="setup-save"
            >
              {update.isPending ? t('setup.saving') : t('setup.save')}
            </Button>
            {saved ? (
              <p role="status" className="text-sm text-muted-foreground" data-testid="setup-saved">
                {t('setup.saved')}
              </p>
            ) : null}
            {failed ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('setup.error.save')}
              </p>
            ) : null}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function SampleDataCard({ status }: { status: OnboardingStatus }) {
  const load = useLoadSampleData();
  const [confirming, setConfirming] = useState(false);
  const { present, counts, removing } = status.sampleData;

  return (
    <Card data-testid="sample-data-card">
      <CardHeader
        title={t('setup.sampleCard.title')}
        description={t('setup.sampleCard.description')}
      />
      <CardBody>
        {removing ? (
          <div role="status" className="flex items-start gap-3" data-testid="sample-removing">
            <Spinner className="mt-0.5" />
            <div>
              <p className="text-sm font-medium">{t('setup.sampleCard.removing')}</p>
              <p className="text-sm text-muted-foreground">{t('setup.sampleCard.removingHint')}</p>
            </div>
          </div>
        ) : present ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="sample-summary">
              {t('setup.sampleCard.summary', {
                accounts: counts.accounts,
                contacts: counts.contacts,
                leads: counts.leads,
                deals: counts.deals,
                tasks: counts.activities,
              })}
            </p>
            <Button
              variant="outline"
              onClick={() => setConfirming(true)}
              data-testid="sample-remove"
            >
              {t('setup.sampleCard.remove')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium" data-testid="sample-none">
                {t('setup.sampleCard.none')}
              </p>
              <p className="text-sm text-muted-foreground">{t('setup.sampleCard.noneHint')}</p>
            </div>
            <Button
              variant="outline"
              loading={load.isPending}
              onClick={() => void load.mutateAsync().catch(() => undefined)}
              data-testid="sample-add"
            >
              {load.isPending ? t('setup.sampleCard.adding') : t('setup.sampleCard.add')}
            </Button>
          </div>
        )}
        {load.isError && !(load.error instanceof ApiRequestError && load.error.status === 409) ? (
          <p role="alert" className="mt-3 text-sm font-medium text-destructive">
            {t('setup.sampleCard.addError')}
          </p>
        ) : null}
      </CardBody>

      {confirming ? <RemoveDialog onClose={() => setConfirming(false)} /> : null}
    </Card>
  );
}

function RemoveDialog({ onClose }: { onClose: () => void }) {
  const remove = useRemoveSampleData();

  return (
    <Dialog
      title={t('setup.remove.title')}
      description={t('setup.remove.body')}
      closeLabel={t('common.close')}
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    >
      <p className="mb-2 text-sm text-muted-foreground">{t('setup.remove.keeps')}</p>
      {remove.isError ? (
        <p role="alert" className="mb-2 text-sm font-medium text-destructive">
          {t('setup.remove.error')}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
          {t('setup.remove.cancel')}
        </Button>
        <Button
          variant="destructive"
          loading={remove.isPending}
          onClick={() => void remove.mutateAsync().then(onClose, () => undefined)}
          data-testid="sample-remove-confirm"
        >
          {t('setup.remove.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
