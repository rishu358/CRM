import { toExportCell } from '@crm/core';

/**
 * CSV output (RFC 4180), written by hand because the one property that matters
 * here is auditable in ten lines: **every cell passes through `toExportCell`**,
 * which is where spreadsheet formula injection is closed (CLAUDE.md §5.11).
 *
 * There is no path in this file by which a value reaches the output without
 * being escaped first. A library that quotes for you and offers escaping as an
 * option is a library where the option can be left off; here there is nothing
 * to leave off.
 *
 * Output starts with a UTF-8 byte-order mark. Excel opens a BOM-less UTF-8 CSV
 * as the system code page and turns "Zoë" into "ZoÃ«"; the importer strips the
 * mark, so a file we export comes back in unchanged.
 */

export const CSV_BOM = '\uFEFF';

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** One record, escaped and quoted, with the line ending Excel expects. */
export function csvLine(cells: readonly unknown[]): string {
  return cells.map((cell) => quote(toExportCell(cell))).join(',') + '\r\n';
}
