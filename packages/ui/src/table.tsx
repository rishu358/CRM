import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn.js';
import { ArrowDownIcon, ArrowUpIcon, SortIcon } from './icons.js';

/**
 * The table kit: the one look every list in the product shares.
 *
 * What makes a dense table readable is mostly what it does not do. There are
 * no vertical rules and no zebra stripes; the header is a quiet band in
 * secondary text so the data, not the chrome, carries the weight; rows are 40px
 * so a screen holds twenty of them; and figures are tabular so a column of
 * rupees lines up on its decimal.
 *
 * These are presentational. The tables still build their columns from what the
 * API returned (CLAUDE.md §5.4) — nothing here knows what a column is.
 */
export function TableCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-x-auto rounded-lg border border-border bg-card shadow-sm', className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-muted', className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border last:border-b-0 transition-colors duration-fast hover:bg-accent/40',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A header cell for a column that cannot be sorted. `numeric` right-aligns it:
 * figures are read by comparing their ends, so a column of money or counts and
 * its header sit against the right edge.
 */
export function Th({
  className,
  numeric = false,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-9 whitespace-nowrap border-b border-border px-4 text-xs font-medium text-muted-foreground',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A header cell for a column that can be sorted. The state is announced with
 * `aria-sort` on the cell, and drawn with an arrow that is more than colour —
 * the current column's arrow points; the others show the neutral up-down mark.
 */
export function SortableTh({
  sorted,
  onSort,
  children,
  className,
  numeric = false,
}: {
  sorted: 'ascending' | 'descending' | undefined;
  onSort: () => void;
  children: ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      aria-sort={sorted}
      className={cn(
        'h-9 whitespace-nowrap border-b border-border p-0',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'flex h-9 w-full items-center gap-1.5 px-4 text-xs font-medium transition-colors duration-fast',
          numeric ? 'justify-end' : 'justify-start text-left',
          'hover:text-foreground',
          sorted === undefined ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {children}
        {sorted === 'ascending' ? (
          <ArrowUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
        ) : sorted === 'descending' ? (
          <ArrowDownIcon aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <SortIcon aria-hidden="true" className="h-3.5 w-3.5 opacity-60" />
        )}
      </button>
    </th>
  );
}

export function Td({
  className,
  numeric = false,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn('h-10 px-4 py-1.5 align-middle', numeric && 'figures text-right', className)}
      {...props}
    />
  );
}
