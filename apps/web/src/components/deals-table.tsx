'use client';

import { Badge, SortableTh, Table, TableCard, THead, Td, Th, Tr } from '@crm/ui';
import type { DealRecord, StageRecord } from '../lib/deals';
import { DEFAULT_PREFERENCES, formatDate, formatMoney } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';
import { EmptyCell, RecordLink, SelectAllTh, SelectRowTd } from './table-parts';
import type { Selection } from '../lib/selection';
import { customCellText } from './custom-fields';
import type { FieldDefinitionView } from '../lib/fields';

/**
 * The deals list view.
 *
 * Cells are drawn from what the API returned: a field the caller may not read
 * is **absent** from the payload rather than null (CLAUDE.md §5.4), so a
 * column for it is simply not rendered — a header over blank cells would name
 * a field the user is not allowed to know exists.
 *
 * `sortKey` is the **API field key** (snake_case), which is what the server
 * validates against field metadata and the field-permission rules.
 */
interface Column {
  readonly key: string;
  readonly label: TranslationKey;
  readonly sortKey: string | null;
}

const COLUMNS: readonly Column[] = [
  { key: 'name', label: 'deal.name', sortKey: 'name' },
  { key: 'stageId', label: 'deal.stage', sortKey: null },
  { key: 'amount', label: 'deal.amount', sortKey: 'amount' },
  { key: 'probability', label: 'deal.probability', sortKey: 'probability' },
  { key: 'expectedCloseDate', label: 'deal.expectedCloseDate', sortKey: 'expected_close_date' },
];

/** Columns whose values are figures: right-aligned, tabular. */
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['amount', 'probability']);

export function DealsTable({
  deals,
  stages,
  customColumns = [],
  sort,
  onSortChange,
  selection,
}: {
  deals: readonly DealRecord[];
  stages: readonly StageRecord[];
  customColumns?: readonly FieldDefinitionView[];
  /** `field` or `-field`, exactly as it goes to the API. */
  sort: string;
  onSortChange: (sort: string) => void;
  /** Row checkboxes, when the list offers bulk actions. */
  selection?: Selection;
}) {
  const active = sort.startsWith('-')
    ? { field: sort.slice(1), descending: true }
    : { field: sort, descending: false };

  const present = new Set<string>();
  for (const deal of deals) {
    for (const key of Object.keys(deal)) present.add(key);
  }
  const columns = COLUMNS.filter((column) => present.has(column.key));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  const toggleSort = (sortKey: string) => {
    onSortChange(active.field === sortKey && !active.descending ? `-${sortKey}` : sortKey);
  };

  const cell = (deal: DealRecord, column: Column) => {
    switch (column.key) {
      case 'name':
        return <RecordLink href={`/deals/${deal.id}`}>{deal.name ?? t('field.empty')}</RecordLink>;
      case 'stageId': {
        const stage = deal.stageId === undefined ? undefined : stageById.get(deal.stageId);
        if (stage === undefined) return null;
        return (
          <Badge
            tone={
              stage.stageType === 'won'
                ? 'success'
                : stage.stageType === 'lost'
                  ? 'destructive'
                  : 'neutral'
            }
          >
            {stage.name}
          </Badge>
        );
      }
      case 'amount':
        return deal.amount == null
          ? null
          : formatMoney(deal.amount.amountMinor, deal.amount.currency, DEFAULT_PREFERENCES);
      case 'probability':
        return deal.probability === undefined ? null : `${deal.probability}%`;
      case 'expectedCloseDate':
        return deal.expectedCloseDate == null
          ? null
          : formatDate(deal.expectedCloseDate, DEFAULT_PREFERENCES);
      default:
        return null;
    }
  };

  return (
    <TableCard>
      <Table>
        <THead>
          <Tr className="hover:bg-transparent">
            {selection === undefined ? null : <SelectAllTh selection={selection} />}
            {columns.map((column) => {
              const numeric = NUMERIC_COLUMNS.has(column.key);
              if (column.sortKey === null) {
                return (
                  <Th key={column.key} numeric={numeric}>
                    {t(column.label)}
                  </Th>
                );
              }
              const sortKey = column.sortKey;
              const sorted = active.field === sortKey;
              return (
                <SortableTh
                  key={column.key}
                  numeric={numeric}
                  sorted={sorted ? (active.descending ? 'descending' : 'ascending') : undefined}
                  onSort={() => toggleSort(sortKey)}
                >
                  {t(column.label)}
                </SortableTh>
              );
            })}
            {customColumns.map((definition) => (
              <Th key={definition.id}>{definition.label}</Th>
            ))}
          </Tr>
        </THead>
        <tbody>
          {deals.map((deal) => (
            <Tr key={deal.id}>
              {selection === undefined ? null : (
                <SelectRowTd
                  selection={selection}
                  id={deal.id}
                  name={deal.name ?? t('field.empty')}
                />
              )}
              {columns.map((column) => {
                const content = cell(deal, column);
                return (
                  <Td key={column.key} numeric={NUMERIC_COLUMNS.has(column.key)}>
                    {content ?? <EmptyCell />}
                  </Td>
                );
              })}
              {customColumns.map((definition) => {
                const text = customCellText(definition, deal);
                return <Td key={definition.id}>{text.length > 0 ? text : <EmptyCell />}</Td>;
              })}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}
