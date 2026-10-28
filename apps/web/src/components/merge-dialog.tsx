'use client';

import type { MergeableObjectType } from '@crm/core';
import { Button, Dialog, DialogFooter, ErrorState, Input, Radio, Skeleton } from '@crm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { useFieldDefinitions } from '../lib/fields';
import { t, tPlural, type PluralBase, type TranslationKey } from '../lib/i18n';
import {
  PLURALS,
  defaultChoices,
  loserFields,
  mergeRows,
  plainValue,
  useMerge,
  useMergeCandidates,
  useMergeRecord,
  type MergeRecord,
  type MergeResult,
} from '../lib/merge';

/**
 * Merge two contacts or two accounts (MVP_SPEC M4, ADR-0064).
 *
 * Three steps in one dialog: pick the other record (unless the "Possible duplicates" card already did),
 * choose which record stays and, field by field, whose value wins, then review what will move before
 * confirming. The review is a dry run of the real request, so the numbers and any refusal are the
 * server's, not a guess made here.
 *
 * The dialog mirrors rules and enforces none: the fields on offer are the ones the API returned for this
 * person (a field they may not read is absent), and every refusal (a stale version, a field they may
 * not write, a pair that cannot be merged) is the API's answer shown in words.
 */

type Step = 'choose' | 'fields' | 'review' | 'done';

const COUNT_LABELS: Readonly<
  Record<
    'activities' | 'notes' | 'files' | 'deals' | 'contacts' | 'childAccounts' | 'leads' | 'tags',
    PluralBase
  >
> = {
  activities: 'merge.count.activities',
  notes: 'merge.count.notes',
  files: 'merge.count.files',
  deals: 'merge.count.deals',
  contacts: 'merge.count.contacts',
  childAccounts: 'merge.count.childAccounts',
  leads: 'merge.count.leads',
  tags: 'merge.count.tags',
};

function displayName(objectType: MergeableObjectType, record: MergeRecord): string {
  const parts =
    objectType === 'contact' ? [record['firstName'], record['lastName']] : [record['name']];
  const name = parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ');
  return name.length > 0 ? name : t('field.empty');
}

function errorText(error: ApiRequestError): string {
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return t('merge.error.conflict');
    case 'FORBIDDEN':
      return t('merge.error.forbidden');
    case 'FIELD_NOT_WRITABLE':
      return t('merge.error.field');
    case 'RECORD_ALREADY_MERGED':
      return t('merge.error.already');
    case 'NOT_FOUND':
      return t('merge.error.notFound');
    case 'IDEMPOTENCY_IN_PROGRESS':
      return t('merge.error.inProgress');
    default:
      // The API's own words for a pair it cannot merge or a value it cannot accept are written for people.
      return error.error.details[0]?.message ?? error.message;
  }
}

export function MergeDialog({
  objectType,
  recordId,
  initialOtherId,
  onClose,
}: {
  objectType: MergeableObjectType;
  /** The record the person is on. */
  recordId: string;
  /** The duplicate they chose from the card, if they did. */
  initialOtherId?: string | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const [otherId, setOtherId] = useState<string | null>(initialOtherId ?? null);
  const [step, setStep] = useState<Step>(initialOtherId === undefined ? 'choose' : 'fields');
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, 'master' | 'loser'>>({});
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<MergeResult | null>(null);
  // One key for this dialog's attempt: a double click or a retry after a dropped connection is the same merge.
  const key = useRef(`merge-${globalThis.crypto.randomUUID()}`);

  const current = useMergeRecord(objectType, recordId);
  const other = useMergeRecord(objectType, otherId);
  const definitions = useFieldDefinitions(objectType);
  const candidates = useMergeCandidates(objectType, search);
  const merge = useMerge(objectType);

  const currentRecord = current.data?.data;
  const otherRecord = other.data?.data;
  const master = keepCurrent ? currentRecord : otherRecord;
  const loser = keepCurrent ? otherRecord : currentRecord;

  const rows = useMemo(
    () =>
      master === undefined || loser === undefined
        ? []
        : mergeRows(objectType, master, loser, definitions.data?.data ?? []),
    [objectType, master, loser, definitions.data],
  );
  const choices = useMemo(() => ({ ...defaultChoices(rows), ...overrides }), [rows, overrides]);

  const request = (dryRun: boolean) => {
    if (master === undefined || loser === undefined) return;
    merge.mutate(
      {
        dryRun,
        key: key.current,
        choices: {
          masterId: master.id,
          masterVersion: master.version,
          loserId: loser.id,
          loserVersion: loser.version,
          fields: loserFields(choices, rows),
        },
      },
      {
        onSuccess: (response) => {
          setResult(response);
          setStep(dryRun ? 'review' : 'done');
        },
      },
    );
  };

  const finish = () => {
    if (result !== null && !result.dryRun && result.masterId !== recordId) {
      router.push(`/${PLURALS[objectType]}/${result.masterId}`);
    }
    onClose();
  };

  const loading = current.isPending || (otherId !== null && other.isPending);
  const loadFailed = current.isError || other.isError;

  return (
    <Dialog
      title={t('merge.title')}
      description={t(`merge.description.${objectType}` as TranslationKey)}
      closeLabel={t('common.close')}
      onClose={step === 'done' ? finish : onClose}
      size="lg"
      data-testid="merge-dialog"
    >
      {loadFailed ? (
        <ErrorState
          title={t('merge.loadError.title')}
          description={t('merge.loadError.description')}
          action={
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
          }
        />
      ) : step === 'choose' ? (
        <div className="space-y-3">
          <Input
            label={t('merge.choose.search')}
            placeholder={t(`merge.choose.placeholder.${objectType}` as TranslationKey)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="merge-search"
          />
          {search.trim().length < 2 ? (
            <p className="text-sm text-muted-foreground">{t('merge.choose.hint')}</p>
          ) : candidates.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : candidates.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('merge.choose.error')}
            </p>
          ) : (
            <ul
              className="divide-y divide-border rounded-md border border-border"
              aria-label={t('merge.choose.results')}
            >
              {candidates.data.data
                .filter((candidate) => candidate.id !== recordId)
                .map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-center justify-between gap-3 p-3 text-sm"
                  >
                    <span className="min-w-0 truncate font-medium">
                      {displayName(objectType, candidate)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOtherId(candidate.id);
                        setOverrides({});
                        setStep('fields');
                      }}
                    >
                      {t('merge.choose.pick')}
                    </Button>
                  </li>
                ))}
              {candidates.data.data.filter((candidate) => candidate.id !== recordId).length ===
              0 ? (
                <li className="p-3 text-sm text-muted-foreground">{t('merge.choose.none')}</li>
              ) : null}
            </ul>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {t('field.cancel')}
            </Button>
          </DialogFooter>
        </div>
      ) : loading ||
        master === undefined ||
        loser === undefined ||
        currentRecord === undefined ||
        otherRecord === undefined ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : step === 'fields' ? (
        <div className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('merge.keep.legend')}</legend>
            <Radio
              name="merge-keep"
              checked={keepCurrent}
              onChange={() => {
                setKeepCurrent(true);
                setOverrides({});
              }}
              label={t('merge.keep.this', { name: displayName(objectType, currentRecord) })}
              description={t('merge.keep.thisHint')}
            />
            <Radio
              name="merge-keep"
              checked={!keepCurrent}
              onChange={() => {
                setKeepCurrent(false);
                setOverrides({});
              }}
              label={t('merge.keep.theOther', { name: displayName(objectType, otherRecord) })}
              description={t('merge.keep.otherHint')}
            />
          </fieldset>

          <div>
            <h3 className="mb-1 text-sm font-medium">{t('merge.fields.title')}</h3>
            <p className="mb-2 text-sm text-muted-foreground">{t('merge.fields.hint')}</p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('merge.fields.none')}</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm" data-testid="merge-fields">
                  <thead>
                    <tr className="bg-muted text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('merge.fields.field')}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('merge.fields.keeps')}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('merge.fields.takes')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row" className="px-3 py-2 text-left font-medium">
                          {row.label}
                        </th>
                        {row.same ? (
                          <td colSpan={2} className="px-3 py-2 text-muted-foreground">
                            {plainValue(row.master) || t('field.empty')}
                            <span className="ml-2 text-xs">{t('merge.fields.same')}</span>
                          </td>
                        ) : (
                          (['master', 'loser'] as const).map((side) => (
                            <td key={side} className="px-3 py-2">
                              <Radio
                                name={`merge-field-${row.key}`}
                                checked={choices[row.key] === side}
                                onChange={() =>
                                  setOverrides((all) => ({ ...all, [row.key]: side }))
                                }
                                label={
                                  plainValue(side === 'master' ? row.master : row.loser) ||
                                  t('field.empty')
                                }
                                data-testid={`merge-${row.key}-${side}`}
                              />
                            </td>
                          ))
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {merge.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(merge.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStep('choose')}>
              {t('merge.back')}
            </Button>
            <Button
              onClick={() => request(true)}
              loading={merge.isPending}
              data-testid="merge-review"
            >
              {t('merge.review')}
            </Button>
          </DialogFooter>
        </div>
      ) : step === 'review' && result !== null ? (
        <div className="space-y-4" data-testid="merge-preview">
          <p className="text-sm">
            {t('merge.review.summary', {
              keep: displayName(objectType, master),
              away: displayName(objectType, loser),
            })}
          </p>
          <ul className="grid gap-1 text-sm sm:grid-cols-2" aria-label={t('merge.review.moves')}>
            {(Object.keys(COUNT_LABELS) as (keyof typeof COUNT_LABELS)[]).map((kind) => {
              const count = result.counts[kind];
              if (count === null || count === 0) return null;
              return <li key={kind}>{tPlural(COUNT_LABELS[kind], count)}</li>;
            })}
          </ul>
          <p className="text-sm text-muted-foreground">{t('merge.review.unseen')}</p>
          <p className="text-sm text-muted-foreground">
            {t(`merge.review.bin.${objectType}` as TranslationKey)}
          </p>
          {merge.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(merge.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStep('fields')}>
              {t('merge.back')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => request(false)}
              loading={merge.isPending}
              data-testid="merge-confirm"
            >
              {t('merge.confirm')}
            </Button>
          </DialogFooter>
        </div>
      ) : result !== null ? (
        <div className="space-y-4" data-testid="merge-done">
          <p role="status" className="text-sm font-medium text-success">
            {t('merge.done.title')}
          </p>
          <p className="text-sm">{t('merge.done.body')}</p>
          <DialogFooter>
            <Link
              href={`/${PLURALS[objectType]}/${result.masterId}`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              onClick={onClose}
            >
              {t('merge.done.open')}
            </Link>
            <Button onClick={finish}>{t('merge.done.close')}</Button>
          </DialogFooter>
        </div>
      ) : null}
    </Dialog>
  );
}
