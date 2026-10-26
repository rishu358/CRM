'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import type { AccountRecord } from '../lib/accounts';
import { SortableTh, Table, TableCard, THead, Td, Th, Tr } from '@crm/ui';
import { DEFAULT_PREFERENCES, formatDate, formatMoney } from '../lib/format';
import { EmptyCell, RecordLink, SelectAllTh, SelectRowTd } from './table-parts';
import type { Selection } from '../lib/selection';
import { t, type TranslationKey } from '../lib/i18n';
import { CUSTOM_COLUMN_PREFIX, customCellText } from './custom-fields';
import type { FieldDefinitionView } from '../lib/fields';

/**
 * The accounts table.
 *
 * Columns are built from what the API actually returned, not from a hardcoded
 * list: a field the caller may not read is **absent** from the payload rather
 * than null (CLAUDE.md §5.4), so rendering a fixed set of columns would show
 * empty cells for data the user is not allowed to know exists. The column
 * chooser is then a filter over what came back, never over what exists — a
 * chooser offering "GSTIN" to someone who cannot see it would leak the schema
 * even with every cell blank.
 *
 * `sortKey` is the **API field key** (snake_case), which is what the server
 * validates against field metadata. The camelCase key is only a property name
 * in the payload; sending it would be rejected, correctly, as an unknown field.
 */
export interface AccountColumn {
  readonly key: string;
  readonly label: TranslationKey;
  readonly sortKey: string;
}

/** Columns whose values are figures: right-aligned, tabular. */
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['annualRevenue', 'employeeCount']);

export const ACCOUNT_COLUMNS: readonly AccountColumn[] = [
  { key: 'name', label: 'account.name', sortKey: 'name' },
  { key: 'domain', label: 'account.domain', sortKey: 'domain' },
  { key: 'industry', label: 'account.industry', sortKey: 'industry' },
  { key: 'phone', label: 'account.phone', sortKey: 'phone' },
  { key: 'email', label: 'account.email', sortKey: 'email' },
  { key: 'gstin', label: 'account.gstin', sortKey: 'gstin' },
  { key: 'annualRevenue', label: 'account.annualRevenue', sortKey: 'annual_revenue' },
  { key: 'employeeCount', label: 'account.employeeCount', sortKey: 'employee_count' },
];

/** The columns shown before anyone chooses. Kept short so the table reads. */
export const DEFAULT_ACCOUNT_COLUMNS: readonly string[] = [
  'name',
  'domain',
  'industry',
  'annualRevenue',
];

/**
 * Render a cell value as text.
 *
 * Money is formatted through the shared helper, so an Indian tenant gets
 * lakh/crore grouping here exactly as it does on the record page. Everything
 * else falls back to JSON rather than "[object Object]", because a column may
 * be a custom field whose type only the tenant's metadata knows.
 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (
    typeof value === 'object' &&
    'amountMinor' in value &&
    'currency' in value &&
    typeof (value as { amountMinor: unknown }).amountMinor === 'string' &&
    typeof (value as { currency: unknown }).currency === 'string'
  ) {
    const money = value as { amountMinor: string; currency: string };
    return formatMoney(money.amountMinor, money.currency, DEFAULT_PREFERENCES);
  }
  return JSON.stringify(value);
}

export function AccountsTable({
  accounts,
  visibleColumns,
  customFields = [],
  sort,
  onSortChange,
  selection,
}: {
  accounts: readonly AccountRecord[];
  visibleColumns: readonly string[];
  /** The custom fields this person may read; those whose key is in `visibleColumns` are shown. */
  customFields?: readonly FieldDefinitionView[];
  /** `field` or `-field`, exactly as it goes to the API. */
  sort: string;
  onSortChange: (sort: string) => void;
  /** Row checkboxes, when the list offers bulk actions. */
  selection?: Selection;
}) {
  const active = sort.startsWith('-')
    ? { field: sort.slice(1), descending: true }
    : { field: sort, descending: false };

  const columns = useMemo<ColumnDef<AccountRecord>[]>(() => {
    const present = new Set<string>();
    for (const account of accounts) {
      for (const key of Object.keys(account)) present.add(key);
    }

    const visible = ACCOUNT_COLUMNS.filter(
      (column) => present.has(column.key) && visibleColumns.includes(column.key),
    );

    const extras: ColumnDef<AccountRecord>[] = customFields
      .filter((definition) => visibleColumns.includes(CUSTOM_COLUMN_PREFIX + definition.key))
      .map((definition): ColumnDef<AccountRecord> => ({
        id: CUSTOM_COLUMN_PREFIX + definition.key,
        header: definition.label,
        accessorFn: (row) => customCellText(definition, row),
        cell: (info) => {
          const value = info.getValue();
          const text = typeof value === 'string' ? value : '';
          return text.length > 0 ? text : <EmptyCell />;
        },
      }));

    const builtIn = visible.map((column, index): ColumnDef<AccountRecord> => ({
      id: column.key,
      header: t(column.label),
      accessorFn: (row) => (row as unknown as Record<string, unknown>)[column.key] ?? null,
      cell: (info) => {
        const text = displayValue(info.getValue());

        // The first column carries the link to the record, so the row has one
        // clear, keyboard-reachable target rather than a click handler on <tr>.
        if (index === 0) {
          return (
            <RecordLink href={`/accounts/${info.row.original.id}`}>
              {text.length > 0 ? text : t('field.empty')}
            </RecordLink>
          );
        }
        return text.length > 0 ? text : <EmptyCell />;
      },
    }));
    return [...builtIn, ...extras];
  }, [accounts, visibleColumns, customFields]);

  const table = useReactTable({
    data: accounts as AccountRecord[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  /** Click a header to sort by it; click again to reverse. */
  const toggleSort = (sortKey: string) => {
    onSortChange(active.field === sortKey && !active.descending ? `-${sortKey}` : sortKey);
  };

  return (
    <TableCard>
      <Table>
        <THead>
          {table.getHeaderGroups().map((headerGroup) => (
            <Tr key={headerGroup.id} className="hover:bg-transparent">
              {selection === undefined ? null : <SelectAllTh selection={selection} />}
              {headerGroup.headers.map((header) => {
                const column = ACCOUNT_COLUMNS.find((candidate) => candidate.key === header.id);
                const numeric = NUMERIC_COLUMNS.has(header.id);
                if (column === undefined) {
                  return (
                    <Th key={header.id} numeric={numeric}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </Th>
                  );
                }
                const sorted = active.field === column.sortKey;
                return (
                  <SortableTh
                    key={header.id}
                    numeric={numeric}
                    // Announced, not only drawn: a screen-reader user needs to
                    // know which column the list is ordered by (WCAG AA).
                    sorted={sorted ? (active.descending ? 'descending' : 'ascending') : undefined}
                    onSort={() => toggleSort(column.sortKey)}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </SortableTh>
                );
              })}
              <Th>{t('account.created')}</Th>
            </Tr>
          ))}
        </THead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Tr key={row.id}>
              {selection === undefined ? null : (
                <SelectRowTd
                  selection={selection}
                  id={row.original.id}
                  name={row.original.name ?? t('field.empty')}
                />
              )}
              {row.getVisibleCells().map((cell) => (
                <Td key={cell.id} numeric={NUMERIC_COLUMNS.has(cell.column.id)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </Td>
              ))}
              <Td className="figures whitespace-nowrap text-muted-foreground">
                {formatDate(row.original.createdAt, DEFAULT_PREFERENCES)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}
