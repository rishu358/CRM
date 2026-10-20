'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import type { LeadRecord } from '../lib/leads';
import { RecordLink, EmptyCell } from './table-parts';
import { formatDate, DEFAULT_PREFERENCES } from '../lib/format';
import { Badge, Table, TableCard, THead, Td, Th, Tr } from '@crm/ui';
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

/** Status is the one column read at a glance, so it gets a tone; the word stays. */
const STATUS_TONES: Readonly<Record<string, 'neutral' | 'primary' | 'success' | 'warning'>> = {
  new: 'primary',
  contacted: 'neutral',
  qualified: 'success',
  unqualified: 'warning',
  converted: 'success',
};

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
            <RecordLink href={`/leads/${info.row.original.id}`}>
              {text.length > 0 ? text : t('field.empty')}
            </RecordLink>
          );
        }
        if (column.key === 'status' && text.length > 0) {
          return <Badge tone={STATUS_TONES[raw] ?? 'neutral'}>{text}</Badge>;
        }
        return text.length > 0 ? text : <EmptyCell />;
      },
    }));
  }, [leads]);

  const table = useReactTable({
    data: leads as LeadRecord[],
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
              <Th>{t('lead.created')}</Th>
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
