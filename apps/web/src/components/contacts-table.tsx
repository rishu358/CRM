'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import type { ContactRecord } from '../lib/contacts';
import { RecordLink, EmptyCell } from './table-parts';
import { formatDate, DEFAULT_PREFERENCES } from '../lib/format';
import { Table, TableCard, THead, Td, Th, Tr } from '@crm/ui';
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
            <RecordLink href={`/contacts/${info.row.original.id}`}>
              {text.length > 0 ? text : t('field.empty')}
            </RecordLink>
          );
        }
        return text.length > 0 ? text : <EmptyCell />;
      },
    }));
  }, [contacts]);

  const table = useReactTable({
    data: contacts as ContactRecord[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <TableCard>
      <Table>
        <THead>
          {table.getHeaderGroups().map((headerGroup) => (
            <Tr key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <Th key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </Th>
              ))}
              <Th>{t('contact.created')}</Th>
            </Tr>
          ))}
        </THead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Td>
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
