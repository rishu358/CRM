'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo } from 'react';
import type { AccountRecord } from '../lib/accounts';
import { DEFAULT_PREFERENCES, formatDate, formatMoney } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';

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
  sort,
  onSortChange,
}: {
  accounts: readonly AccountRecord[];
  visibleColumns: readonly string[];
  /** `field` or `-field`, exactly as it goes to the API. */
  sort: string;
  onSortChange: (sort: string) => void;
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

    return visible.map((column, index) => ({
      id: column.key,
      header: t(column.label),
      accessorFn: (row) => (row as unknown as Record<string, unknown>)[column.key] ?? null,
      cell: (info) => {
        const text = displayValue(info.getValue());

        // The first column carries the link to the record, so the row has one
        // clear, keyboard-reachable target rather than a click handler on <tr>.
        if (index === 0) {
          return (
            <Link
              href={`/accounts/${info.row.original.id}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {text.length > 0 ? text : t('field.empty')}
            </Link>
          );
        }
        return text.length > 0 ? (
          text
        ) : (
          <span className="text-muted-foreground">{t('field.empty')}</span>
        );
      },
    }));
  }, [accounts, visibleColumns]);

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
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const column = ACCOUNT_COLUMNS.find((candidate) => candidate.key === header.id);
                const sorted = column !== undefined && active.field === column.sortKey;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    // Announced, not only drawn: a screen-reader user needs to
                    // know which column the list is ordered by (WCAG AA).
                    aria-sort={
                      sorted ? (active.descending ? 'descending' : 'ascending') : undefined
                    }
                    className="px-0 py-0 text-left font-medium text-muted-foreground"
                  >
                    {column === undefined ? (
                      <span className="block px-4 py-2.5">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.sortKey)}
                        className="flex w-full items-center gap-1 px-4 py-2.5 text-left hover:text-foreground"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span aria-hidden="true" className="text-xs">
                          {sorted ? (active.descending ? '▾' : '▴') : ''}
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t('account.created')}
              </th>
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-t border-border hover:bg-accent/40">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-2.5">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
              <td className="px-4 py-2.5 text-muted-foreground">
                {formatDate(row.original.createdAt, DEFAULT_PREFERENCES)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
