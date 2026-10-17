'use client';

import { Badge } from '@crm/ui';
import Link from 'next/link';
import type { DealRecord, StageRecord } from '../lib/deals';
import { DEFAULT_PREFERENCES, formatDate, formatMoney } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';

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

export function DealsTable({
  deals,
  stages,
  sort,
  onSortChange,
}: {
  deals: readonly DealRecord[];
  stages: readonly StageRecord[];
  /** `field` or `-field`, exactly as it goes to the API. */
  sort: string;
  onSortChange: (sort: string) => void;
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
        return (
          <Link
            href={`/deals/${deal.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {deal.name ?? t('field.empty')}
          </Link>
        );
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
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((column) => {
              const sorted = column.sortKey !== null && active.field === column.sortKey;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sorted ? (active.descending ? 'descending' : 'ascending') : undefined}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground"
                >
                  {column.sortKey === null ? (
                    t(column.label)
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.sortKey as string)}
                      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground"
                    >
                      {t(column.label)}
                      {sorted ? (
                        <span aria-hidden="true">{active.descending ? '↓' : '↑'}</span>
                      ) : null}
                      {sorted ? (
                        <span className="sr-only">
                          {active.descending
                            ? t('deals.sortedDescending')
                            : t('deals.sortedAscending')}
                        </span>
                      ) : null}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => (
            <tr key={deal.id} className="border-t border-border">
              {columns.map((column) => {
                const content = cell(deal, column);
                return (
                  <td key={column.key} className="px-3 py-2">
                    {content ?? <span className="text-muted-foreground">{t('field.empty')}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
