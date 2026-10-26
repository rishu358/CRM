'use client';

import {
  BULK_EDITABLE_FIELDS,
  BULK_MAX_RECORDS,
  type BusinessObjectType,
  type BulkSkipReason,
} from '@crm/core';
import type { BulkActionInput, BulkResult, Tag, ViewFilters } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';
import { t } from './i18n';
import type { FieldDefinitionView } from './fields';

/**
 * Server state for bulk actions and the tag picker (CLAUDE.md §9, MVP_SPEC M3 and M4, ADR-0056).
 *
 * A call changes at most 200 records, so "everything this view matches" is a loop: the API hands
 * back a cursor until nothing is left. The loop is here, once, so no list screen has to write it,
 * and so the result a person reads adds up every batch rather than reporting the first.
 */

export type { BulkResult, Tag };

/** What a bulk action is aimed at. */
export type BulkTargetChoice =
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | { readonly kind: 'filter'; readonly filter: ViewFilters };

/** The action part of a request: everything but which records. */
export type BulkActionChoice =
  | { readonly action: 'edit'; readonly changes: Record<string, unknown> }
  | { readonly action: 'assign'; readonly ownerId: string }
  | { readonly action: 'delete' }
  | { readonly action: 'tag_add' | 'tag_remove'; readonly tags: readonly string[] };

export interface BulkTotals {
  readonly matched: number;
  readonly changed: number;
  readonly skipped: Record<BulkSkipReason, number>;
  readonly batches: number;
}

const EMPTY_SKIPS: Record<BulkSkipReason, number> = {
  not_found: 0,
  not_permitted: 0,
  version_conflict: 0,
  invalid: 0,
  no_change: 0,
};

/** Most batches one click may run: 50 x 200 = 10,000 records, then it stops and says so. */
const MAX_BATCHES = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function newKey(): string {
  return `bulk-${globalThis.crypto.randomUUID()}`;
}

export function useTags(enabled = true) {
  return useQuery<ItemEnvelope<Tag[]>, ApiRequestError>({
    queryKey: ['tags'],
    queryFn: () => api.get<ItemEnvelope<Tag[]>>('/tags'),
    enabled,
    staleTime: 60_000,
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
  });
}

/**
 * Run a bulk action to completion.
 *
 * Every request carries its own Idempotency-Key, so a retry of a request that timed out replays
 * the stored answer instead of editing, deleting or tagging the same records again. A new key per
 * batch, because the next batch is a different request.
 */
export function useBulkAction(objectType: BusinessObjectType) {
  const client = useQueryClient();
  const [progress, setProgress] = useState<BulkTotals | null>(null);

  const mutation = useMutation<
    BulkTotals & { readonly stoppedEarly: boolean; readonly lastResult: BulkResult | null },
    ApiRequestError,
    { target: BulkTargetChoice; choice: BulkActionChoice }
  >({
    mutationFn: async ({ target, choice }) => {
      let totals: BulkTotals = { matched: 0, changed: 0, skipped: { ...EMPTY_SKIPS }, batches: 0 };
      let after: string | undefined;
      let last: BulkResult | null = null;
      // More ticked rows than one call may take are sent as several calls of at most the cap.
      const idBatches = target.kind === 'ids' ? chunk(target.ids, BULK_MAX_RECORDS) : [];

      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const body: BulkActionInput = {
          objectType,
          dryRun: false,
          ...choice,
          target:
            target.kind === 'ids'
              ? { kind: 'ids', ids: idBatches[batch] ?? [] }
              : {
                  kind: 'filter',
                  filter: target.filter,
                  ...(after === undefined ? {} : { after }),
                },
        } as BulkActionInput;

        const response = await api.post<ItemEnvelope<BulkResult>>('/bulk-actions', body, {
          'idempotency-key': newKey(),
        });
        const result = response.data;
        last = result;

        const skipped = { ...totals.skipped };
        for (const entry of result.skipped) skipped[entry.reason] += 1;
        totals = {
          matched: totals.matched + result.matched,
          changed: totals.changed + result.changed,
          skipped,
          batches: totals.batches + 1,
        };
        setProgress(totals);

        const finished =
          target.kind === 'ids' ? batch + 1 >= idBatches.length : result.nextCursor === null;
        if (finished) return { ...totals, stoppedEarly: false, lastResult: last };
        after = result.nextCursor ?? undefined;
      }
      return { ...totals, stoppedEarly: true, lastResult: last };
    },
    onSettled: () => {
      // The lists, the record pages and the tag picker may all draw differently now.
      void client.invalidateQueries();
    },
  });

  const run = mutation.mutateAsync;
  const reset = useCallback(() => {
    setProgress(null);
    mutation.reset();
  }, [mutation]);

  return { ...mutation, run, progress, reset };
}

/* -------------------------------------------------------------------------- */
/* What a bulk edit may change, as the dialog offers it                         */
/* -------------------------------------------------------------------------- */

export type EditInput =
  | { readonly kind: 'text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'date' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'select'; readonly options: readonly { value: string; label: string }[] };

export interface EditableField {
  readonly key: string;
  readonly label: string;
  readonly input: EditInput;
}

/**
 * The system fields the dialog can offer an input for. The API allows a few more (a contact's
 * account, a parent account: references, which need a record picker the dialog does not have);
 * those are reachable through the API and not from this screen.
 */
const SYSTEM_INPUTS: Readonly<Record<string, EditInput>> = {
  title: { kind: 'text' },
  lead_source: { kind: 'text' },
  industry: { kind: 'text' },
  employee_count: { kind: 'number' },
  company: { kind: 'text' },
  source: { kind: 'text' },
  status: {
    kind: 'select',
    options: [
      { value: 'new', label: t('lead.status.new') },
      { value: 'contacted', label: t('lead.status.contacted') },
      { value: 'qualified', label: t('lead.status.qualified') },
      { value: 'unqualified', label: t('lead.status.unqualified') },
    ],
  },
  expected_close_date: { kind: 'date' },
  lost_reason: { kind: 'text' },
};

/**
 * The fields a bulk edit of this object may change **for this person**: the allowlist the API
 * enforces, the fields they may write, and every active custom field of a type the dialog can
 * enter. Offering a field the API will refuse would be a switch wired to nothing.
 */
export function editableFields(
  objectType: BusinessObjectType,
  definitions: readonly FieldDefinitionView[],
  stages?: readonly { id: string; name: string }[],
): EditableField[] {
  const result: EditableField[] = [];

  for (const allowed of BULK_EDITABLE_FIELDS[objectType]) {
    const definition = definitions.find((field) => field.key === allowed.key);
    if (definition === undefined || !definition.writable) continue;

    if (allowed.key === 'stage_id') {
      if (stages !== undefined && stages.length > 0) {
        result.push({
          key: allowed.key,
          label: definition.label,
          input: {
            kind: 'select',
            options: stages.map((stage) => ({ value: stage.id, label: stage.name })),
          },
        });
      }
      continue;
    }
    const input = SYSTEM_INPUTS[allowed.key];
    if (input !== undefined) result.push({ key: allowed.key, label: definition.label, input });
  }

  for (const definition of definitions) {
    if (definition.isSystem || !definition.isActive || !definition.writable) continue;
    const input = customInput(definition);
    if (input !== null) result.push({ key: definition.key, label: definition.label, input });
  }
  return result;
}

function customInput(definition: FieldDefinitionView): EditInput | null {
  switch (definition.type) {
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
      return { kind: 'text' };
    case 'number':
    case 'percent':
      return { kind: 'number' };
    case 'date':
      return { kind: 'date' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'currency':
    case 'datetime':
    case 'multi_picklist':
    case 'user_lookup':
      return null;
    case 'picklist':
      return {
        kind: 'select',
        options: (definition.options ?? [])
          .filter((option) => option.isActive !== false)
          .map((option) => ({ value: option.value, label: option.label })),
      };
    default:
      return null;
  }
}

/** The JSON value the API expects for what was entered; `null` clears the field. */
export function editValue(input: EditInput, raw: string, clear: boolean): unknown {
  if (clear) return null;
  switch (input.kind) {
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === 'true';
    case 'text':
    case 'date':
    case 'select':
      return raw;
  }
}

export function useEditableFields(
  objectType: BusinessObjectType,
  definitions: readonly FieldDefinitionView[],
  stages?: readonly { id: string; name: string }[],
): EditableField[] {
  return useMemo(
    () => editableFields(objectType, definitions, stages),
    [objectType, definitions, stages],
  );
}
