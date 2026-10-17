'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo } from 'react';
import type { LeadRecord } from '../lib/leads';
import { formatDate, DEFAULT_PREFERENCES } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * The leads table.
 *
 * Columns are built from what the API actually returned, not from a hardcoded
 * list: a field the caller may not read is **absent** from the payload rather
 * than null (CLAUDE.md §5.4), so rendering a fixed set of columns would show
 * empty cells for data the user is not allowed to know exists.
 */
const CANDIDATE_COLUMNS = [
  { key: 'lastName', label: 'lead.lastName' },
  { key: 'firstName', label: 'lead.firstName' },
  { key: 'company', label: 'lead.company' },
  { key: 'email', label: 'lead.email' },
  { key: 'phone', label: 'lead.phone' },
  { key: 'status', label: 'lead.status' },
  { key: 'source', label: 'lead.source' },
] as const;

/**
 * Render a cell value as text.
 *
 * `accessorFn` is typed `unknown` because a column may be a custom field whose
 * type only the tenant's metadata knows. Objects and arrays would stringify to
 * "[object Object]", so they are rendered as JSON instead of silently becoming
 * noise on the screen.
 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function LeadsTable({ leads }: { leads: readonly LeadRecord[] }) {
  const columns = useMemo<ColumnDef<LeadRecord>[]>(() => {
    const present = new Set<string>();
    for (const lead of leads) {
      for (const key of Object.keys(lead)) present.add(key);
    }

    const visible = CANDIDATE_COLUMNS.filter((column) => present.has(column.key));

    return visible.map((column, index) => ({
      id: column.key,
      header: t(column.label),
      accessorFn: (row) => (row as unknown as Record<string, unknown>)[column.key] ?? null,
      cell: (info) => {
        // Status is stored as a stable key and shown as a translated word.
        const raw = displayValue(info.getValue());
        const text =
          column.key === 'status' && raw.length > 0
            ? t(`lead.status.${raw}` as TranslationKey)
            : raw;

        // The first column carries the link to the record, so the row has one
        // clear, keyboard-reachable target rather than a click handler on <tr>.
        if (index === 0) {
          return (
            <Link
              href={`/leads/${info.row.original.id}`}
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
  }, [leads]);

  const table = useReactTable({
    data: leads as LeadRecord[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  className="px-4 py-2.5 text-left font-medium text-muted-foreground"
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                {t('lead.created')}
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
