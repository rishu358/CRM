'use client';

import { MERGE_FIELDS, type MergeableObjectType } from '@crm/core';
import type { MergeResult } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';
import type { FieldDefinitionView } from './fields';
import type { DuplicateMatch } from './leads';

/**
 * Server state for merging a duplicate (MVP_SPEC M4, ADR-0064).
 *
 * The screen only mirrors the rules: every one of them (who may merge, which fields may be chosen, the
 * versions, the cap, the hierarchy) is checked again by the API, and what it answers is what is shown.
 */

export type { MergeResult };

export const PLURALS: Readonly<Record<MergeableObjectType, 'contacts' | 'accounts'>> = {
  contact: 'contacts',
  account: 'accounts',
};

export const mergeKeys = {
  duplicates: (objectType: MergeableObjectType, id: string) =>
    ['duplicates', objectType, id] as const,
  record: (objectType: MergeableObjectType, id: string) =>
    ['merge', 'record', objectType, id] as const,
  candidates: (objectType: MergeableObjectType, q: string) =>
    ['merge', 'candidates', objectType, q] as const,
};

/** The records this one may duplicate. A 403 means this person may not merge, so the card is not shown. */
export function useDuplicates(objectType: MergeableObjectType, id: string) {
  return useQuery<ItemEnvelope<DuplicateMatch[]>, ApiRequestError>({
    queryKey: mergeKeys.duplicates(objectType, id),
    queryFn: () =>
      api.get<ItemEnvelope<DuplicateMatch[]>>(`/${PLURALS[objectType]}/${id}/duplicates`),
    retry: (count, error) => error.status !== 403 && error.status !== 404 && count < 2,
  });
}

/** One record as the person may read it: a field they may not read is simply absent. */
export interface MergeRecord {
  readonly id: string;
  readonly version: number;
  readonly [key: string]: unknown;
}

export function useMergeRecord(objectType: MergeableObjectType, id: string | null) {
  return useQuery<ItemEnvelope<MergeRecord>, ApiRequestError>({
    queryKey: mergeKeys.record(objectType, id ?? 'none'),
    queryFn: () => api.get<ItemEnvelope<MergeRecord>>(`/${PLURALS[objectType]}/${id}`),
    enabled: id !== null,
    // A merge is decided against the version on screen, so never serve an older copy than the server has.
    staleTime: 0,
    gcTime: 0,
  });
}

/** Records the person could merge with: the list's own search, so it obeys the same scope and field rules. */
export function useMergeCandidates(objectType: MergeableObjectType, q: string) {
  const term = q.trim();
  return useQuery<{ data: MergeRecord[] }, ApiRequestError>({
    queryKey: mergeKeys.candidates(objectType, term),
    queryFn: () =>
      api.get<{ data: MergeRecord[] }>(
        `/${PLURALS[objectType]}?${new URLSearchParams({ q: term, limit: '8', sort: '-updated_at' }).toString()}`,
      ),
    enabled: term.length >= 2,
  });
}

export interface MergeChoices {
  readonly masterId: string;
  readonly masterVersion: number;
  readonly loserId: string;
  readonly loserVersion: number;
  /** Field key to which record's value wins; only the fields where the loser's does. */
  readonly fields: Readonly<Record<string, 'loser'>>;
}

/** Preview (dry run) or do the merge. One request shape, so the preview cannot differ from the merge. */
export function useMerge(objectType: MergeableObjectType) {
  const client = useQueryClient();
  return useMutation<
    MergeResult,
    ApiRequestError,
    { choices: MergeChoices; dryRun: boolean; key: string }
  >({
    mutationFn: async ({ choices, dryRun, key }) => {
      const response = await api.post<ItemEnvelope<MergeResult>>(
        '/merges',
        { objectType, ...choices, dryRun },
        dryRun ? undefined : { 'idempotency-key': key },
      );
      return response.data;
    },
    onSuccess: (_result, variables) => {
      // A preview changes nothing. A merge changes both records, their lists, search and the page.
      if (!variables.dryRun) void client.invalidateQueries();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* The field table                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fields that hold the id of another record. Their value is an id nobody can read, so the dialog says
 * "a linked company" rather than showing it, and the label is the person's word, not the field key.
 */
export const REFERENCE_FIELDS: Readonly<
  Record<string, 'merge.field.company' | 'merge.field.parent'>
> = {
  accountId: 'merge.field.company',
  parentAccountId: 'merge.field.parent',
};

export interface MergeFieldRow {
  /** The key the API takes in `fields`: the API name for a standard field, the field key for a custom one. */
  readonly key: string;
  readonly label: string;
  readonly master: unknown;
  readonly loser: unknown;
  /** The two say the same thing: nothing to choose. */
  readonly same: boolean;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** One value as a person reads it. Addresses and money are objects; they are shown flattened, not as JSON. */
export function plainValue(value: unknown): string {
  if (isEmpty(value)) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const parts = Object.values(value as Record<string, unknown>)
      .filter((part) => !isEmpty(part))
      .map((part) =>
        typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean'
          ? String(part)
          : JSON.stringify(part),
      );
    return parts.join(', ');
  }
  return '';
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The fields to choose between: those the API returned for **either** record (so a field this person may
 * not read is not here, for either), standard fields first and in the order the company set, then the
 * custom ones. Built from what came back, never from a fixed list of what exists.
 */
export function mergeRows(
  objectType: MergeableObjectType,
  master: MergeRecord,
  loser: MergeRecord,
  definitions: readonly FieldDefinitionView[],
): MergeFieldRow[] {
  const labelOf = (fieldKey: string, fallback: string) =>
    definitions.find((definition) => definition.key === fieldKey)?.label ?? fallback;

  const rows: MergeFieldRow[] = [];
  for (const field of MERGE_FIELDS[objectType]) {
    if (!(field.apiKey in master) && !(field.apiKey in loser)) continue;
    const a = master[field.apiKey];
    const b = loser[field.apiKey];
    rows.push({
      key: field.apiKey,
      label: labelOf(field.fieldKey, field.fieldKey),
      master: a,
      loser: b,
      same: sameValue(a, b),
    });
  }

  const masterCustom = (master['customFields'] ?? {}) as Record<string, unknown>;
  const loserCustom = (loser['customFields'] ?? {}) as Record<string, unknown>;
  for (const definition of definitions) {
    if (definition.isSystem) continue;
    if (!(definition.key in masterCustom) && !(definition.key in loserCustom)) continue;
    rows.push({
      key: definition.key,
      label: definition.label,
      master: masterCustom[definition.key],
      loser: loserCustom[definition.key],
      same: sameValue(masterCustom[definition.key], loserCustom[definition.key]),
    });
  }
  return rows;
}

/**
 * A sensible starting point for each field. The master's value wins, as the server's default is,
 * except where the master has nothing and the other record has something: then the other's is offered,
 * so a merge does not quietly lose a phone number just because it was on the record being folded in.
 */
export function defaultChoices(rows: readonly MergeFieldRow[]): Record<string, 'master' | 'loser'> {
  const choices: Record<string, 'master' | 'loser'> = {};
  for (const row of rows) {
    choices[row.key] = isEmpty(row.master) && !isEmpty(row.loser) ? 'loser' : 'master';
  }
  return choices;
}

/** Only the fields where the other record's value wins are sent; the rest keep the master's. */
export function loserFields(
  choices: Readonly<Record<string, 'master' | 'loser'>>,
  rows: readonly MergeFieldRow[],
): Record<string, 'loser'> {
  const result: Record<string, 'loser'> = {};
  for (const row of rows) {
    if (!row.same && choices[row.key] === 'loser') result[row.key] = 'loser';
  }
  return result;
}
