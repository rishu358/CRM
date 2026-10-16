'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo } from 'react';
import type { ContactRecord } from '../lib/contacts';
import { formatDate, DEFAULT_PREFERENCES } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * The contacts table.
 *
 * Columns are built from what the API actually returned, not from a hardcoded
 * list: a field the caller may not read is **absent** from the payload rather
 * than null (CLAUDE.md §5.4), so rendering a fixed set of columns would show
 * empty cells for data the user is not allowed to know exists.
 */
const CANDIDATE_COLUMNS = [
  { key: 'lastName', label: 'contact.lastName' },
  { key: 'firstName', label: 'contact.firstName' },
  { key: 'email', label: 'contact.email' },
  { key: 'phone', label: 'contact.phone' },
  { key: 'title', label: 'contact.title' },
  { key: 'leadSource', label: 'contact.leadSource' },
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

export function ContactsTable({ contacts }: { contacts: readonly ContactRecord[] }) {
  const columns = useMemo<ColumnDef<ContactRecord>[]>(() => {
    const present = new Set<string>();
    for (const contact of contacts) {
      for (const key of Object.keys(contact)) present.add(key);
    }

    const visible = CANDIDATE_COLUMNS.filter((column) => present.has(column.key));

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
              href={`/contacts/${info.row.original.id}`}
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
  }, [contacts]);

  const table = useReactTable({
    data: contacts as ContactRecord[],
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
                {t('contact.created')}
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
