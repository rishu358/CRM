'use client';

import { QUERY_COLUMNS, type BusinessObjectType } from '@crm/core';
import type { FilterOperator, SavedView, ViewCondition } from '@crm/contracts';
import { useCallback, useMemo, useState } from 'react';
import type { FieldDefinitionView } from './fields';

/**
 * The state of a list that a saved view stores: the search, the conditions and the sort, and the
 * columns the page chooses to report (MVP_SPEC M4, ADR-0056).
 *
 * One hook for the four lists, so "the list at this moment" means the same thing on every screen
 * and a saved view is applied by the same code. It holds **only what the person typed**: whether a
 * field exists, is readable or is allowed is for the API to say, as it does for a list URL.
 */

/** What a list hook needs to build a request. */
export interface ListParams {
  readonly q: string;
  readonly conditions: readonly ViewCondition[];
  /** `field` or `-field`, as the list endpoint takes it. */
  readonly sort: string;
}

export function filterStrings(conditions: readonly ViewCondition[]): string[] {
  return conditions.map(
    (condition) => `${condition.field}:${condition.operator}:${condition.value}`,
  );
}

/** A request's query string for a list page: shared so four lists cannot spell it four ways. */
export function listSearchParams(
  params: ListParams,
  options: { cursor?: string | null; extraFilters?: readonly string[] } = {},
): URLSearchParams {
  const query = new URLSearchParams({ limit: '50', sort: params.sort });
  for (const filter of [...(options.extraFilters ?? []), ...filterStrings(params.conditions)]) {
    query.append('filter', filter);
  }
  if (params.q.length > 0) query.set('q', params.q);
  if (typeof options.cursor === 'string') query.set('cursor', options.cursor);
  return query;
}

/** A stable key for a query cache: two equal lists share one entry. */
export function listKey(params: ListParams): string {
  return JSON.stringify([params.q, params.conditions, params.sort]);
}

export function sortToView(sort: string): { field: string; direction: 'asc' | 'desc' } {
  return sort.startsWith('-')
    ? { field: sort.slice(1), direction: 'desc' }
    : { field: sort, direction: 'asc' };
}

export function sortFromView(view: SavedView['sort']): string | null {
  const first = view[0];
  if (first === undefined) return null;
  return first.direction === 'desc' ? `-${first.field}` : first.field;
}

/* -------------------------------------------------------------------------- */
/* Which fields a condition may use, and how                                    */
/* -------------------------------------------------------------------------- */

export type ValueKind = 'text' | 'number' | 'date' | 'timestamp' | 'boolean' | 'picklist';

export interface FilterableField {
  readonly key: string;
  readonly label: string;
  readonly valueKind: ValueKind;
  readonly operators: readonly FilterOperator[];
  /** For a picklist: the values on offer. */
  readonly options: readonly { value: string; label: string }[];
}

const NULLS: readonly FilterOperator[] = ['is_null', 'is_not_null'];
const TEXT_OPERATORS: readonly FilterOperator[] = [
  'contains',
  'starts_with',
  'eq',
  'neq',
  ...NULLS,
];
const NUMBER_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  ...NULLS,
];
const DATE_OPERATORS: readonly FilterOperator[] = ['eq', 'gt', 'gte', 'lt', 'lte', ...NULLS];
const TIMESTAMP_OPERATORS: readonly FilterOperator[] = ['gte', 'lt', ...NULLS];
const PICKLIST_OPERATORS: readonly FilterOperator[] = ['eq', 'neq', ...NULLS];

/**
 * How a field is offered in the filter builder, or `null` when it is not.
 *
 * A custom field is stored as JSON and compared by the API as **text** (`resolveColumn` in
 * `@crm/db`), so only the operators that mean the same thing on text are offered for it: a
 * number is `is` / `is not`, not "greater than" (as text, 9 is greater than 10). A reference to
 * another record (an id) is not offered at all: nobody can type one.
 */
export function filterableField(
  objectType: BusinessObjectType,
  field: Pick<FieldDefinitionView, 'key' | 'label' | 'type' | 'isSystem' | 'options'>,
): FilterableField | null {
  const options = (field.options ?? [])
    .filter((option) => option.isActive !== false)
    .map((option) => ({ value: option.value, label: option.label }));

  if (field.isSystem) {
    const kind = Object.hasOwn(QUERY_COLUMNS[objectType], field.key)
      ? QUERY_COLUMNS[objectType][field.key]
      : undefined;
    switch (kind) {
      case 'text':
        // A system field with a list of answers (a lead source) is chosen from it, not typed.
        return options.length > 0
          ? base(field, 'picklist', PICKLIST_OPERATORS, options)
          : base(field, 'text', TEXT_OPERATORS, options);
      case 'number':
        return base(field, 'number', NUMBER_OPERATORS, options);
      case 'date':
        return base(field, 'date', DATE_OPERATORS, options);
      case 'timestamp':
        return base(field, 'timestamp', TIMESTAMP_OPERATORS, options);
      case 'uuid':
      case undefined:
        // A reference (nobody can type an id) or not a queryable column at all.
        return null;
    }
  }

  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
      return base(field, 'text', TEXT_OPERATORS, options);
    case 'number':
    case 'percent':
      return base(field, 'number', ['eq', 'neq', ...NULLS], options);
    case 'date':
      return base(field, 'date', DATE_OPERATORS, options);
    case 'boolean':
      return base(field, 'boolean', ['eq', ...NULLS], options);
    case 'picklist':
      return base(field, 'picklist', PICKLIST_OPERATORS, options);
    case 'currency':
    case 'datetime':
    case 'multi_picklist':
    case 'user_lookup':
      // Money is in minor units, a datetime and a list of answers have no honest single value to
      // type, and a person is chosen, not typed.
      return null;
  }
}

function base(
  field: { key: string; label: string },
  valueKind: ValueKind,
  operators: readonly FilterOperator[],
  options: FilterableField['options'],
): FilterableField {
  return { key: field.key, label: field.label, valueKind, operators, options };
}

export function operatorNeedsValue(operator: FilterOperator): boolean {
  return operator !== 'is_null' && operator !== 'is_not_null';
}

/** Is this row of the builder complete enough to send? */
export function isCompleteCondition(condition: ViewCondition): boolean {
  return !operatorNeedsValue(condition.operator) || condition.value.trim().length > 0;
}

/** The fields the builder offers, in the company's order, from the metadata the API returned. */
export function filterableFields(
  objectType: BusinessObjectType,
  definitions: readonly FieldDefinitionView[],
  builtIn: readonly { key: string; label: string }[],
): FilterableField[] {
  const seen = new Set<string>();
  const result: FilterableField[] = [];
  for (const definition of definitions) {
    if (!definition.isActive) continue;
    const candidate = filterableField(objectType, definition);
    if (candidate !== null && !seen.has(candidate.key)) {
      seen.add(candidate.key);
      result.push(candidate);
    }
  }
  for (const extra of builtIn) {
    if (seen.has(extra.key)) continue;
    const candidate = filterableField(objectType, {
      key: extra.key,
      label: extra.label,
      type: 'text',
      isSystem: true,
    });
    if (candidate !== null) result.push(candidate);
  }
  return result;
}

/** Sort options are the same fields, ascending and descending. */
export function sortableKeys(fields: readonly FilterableField[]): string[] {
  return fields.filter((field) => field.valueKind !== 'boolean').map((field) => field.key);
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                     */
/* -------------------------------------------------------------------------- */

export interface ListView {
  readonly q: string;
  readonly setQ: (q: string) => void;
  readonly conditions: readonly ViewCondition[];
  readonly setConditions: (next: readonly ViewCondition[]) => void;
  readonly sort: string;
  readonly setSort: (sort: string) => void;
  readonly params: ListParams;
  readonly activeView: SavedView | null;
  /** Show this view's search, conditions, sort and columns; `null` is "all records". */
  readonly applyView: (view: SavedView | null) => void;
  /** The list differs from the active view (or, with none, from the defaults). */
  readonly isDirty: boolean;
  /** Anything narrowing the list at all. */
  readonly isFiltered: boolean;
  readonly reset: () => void;
  /** The columns the page is showing now, as field keys: what a saved view stores. */
  readonly currentColumns: readonly string[];
}

export function useListView(options: {
  readonly defaultSort: string;
  /** The columns the page is showing now, as field keys, for saving. */
  readonly getColumns: () => readonly string[];
  /** Show these columns, as field keys. */
  readonly setColumns: (keys: readonly string[]) => void;
  readonly onViewApplied?: () => void;
}): ListView {
  const { defaultSort, getColumns, setColumns, onViewApplied } = options;
  const [q, setQ] = useState('');
  const [conditions, setConditions] = useState<readonly ViewCondition[]>([]);
  const [sort, setSort] = useState(defaultSort);
  const [activeView, setActiveView] = useState<SavedView | null>(null);

  const applyView = useCallback(
    (view: SavedView | null) => {
      setActiveView(view);
      setQ(view?.filters.q ?? '');
      setConditions(view?.filters.conditions ?? []);
      setSort((view === null ? null : sortFromView(view.sort)) ?? defaultSort);
      setColumns(view?.columns ?? []);
      onViewApplied?.();
    },
    [defaultSort, setColumns, onViewApplied],
  );

  const reset = useCallback(() => applyView(null), [applyView]);

  const params = useMemo<ListParams>(() => ({ q, conditions, sort }), [q, conditions, sort]);
  const currentColumns = getColumns();

  const baseline = useMemo(
    () => ({
      q: activeView?.filters.q ?? '',
      conditions: activeView?.filters.conditions ?? [],
      sort: (activeView === null ? null : sortFromView(activeView.sort)) ?? defaultSort,
      columns: activeView?.columns ?? [],
    }),
    [activeView, defaultSort],
  );
  const isDirty =
    JSON.stringify([q, conditions, sort, currentColumns]) !==
    JSON.stringify([baseline.q, baseline.conditions, baseline.sort, baseline.columns]);

  return {
    q,
    setQ,
    conditions,
    setConditions,
    sort,
    setSort,
    params,
    activeView,
    applyView,
    isDirty,
    isFiltered: q.length > 0 || conditions.length > 0,
    reset,
    currentColumns,
  };
}
