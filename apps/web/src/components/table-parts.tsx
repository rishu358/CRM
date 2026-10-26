import { Checkbox, Td, Th } from '@crm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { t } from '../lib/i18n';
import type { Selection } from '../lib/selection';

/**
 * The link that opens a record, in the first column of every list.
 *
 * Set in the foreground colour and weight, not link-blue: a column of twenty
 * blue underlined names is twenty things shouting, and the first column is
 * already the one people scan. Teal appears on hover and focus, which is when
 * "this is clickable" is the useful thing to say. It is still a real anchor,
 * so the row has exactly one keyboard-reachable target.
 */
export function RecordLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm font-medium text-foreground underline-offset-4 transition-colors duration-fast hover:text-primary hover:underline"
    >
      {children}
    </Link>
  );
}

/** What a cell shows when there is nothing to show. */
export function EmptyCell() {
  return <span className="text-muted-foreground">{t('field.empty')}</span>;
}

/**
 * The header cell that ticks every row on screen (MVP_SPEC M4, bulk actions).
 *
 * A tri-state: ticked when every loaded row is, mixed when some are. Keyboard and
 * screen-reader users get a real checkbox with a name, not a styled cell.
 */
export function SelectAllTh({ selection }: { selection: Selection }) {
  return (
    <Th className="w-10 pr-0">
      <Checkbox
        hideLabel
        label={t('bulk.selectAll')}
        checked={selection.allVisibleSelected}
        onChange={selection.toggleAllVisible}
        ref={(input) => {
          if (input !== null) input.indeterminate = selection.someVisibleSelected;
        }}
      />
    </Th>
  );
}

/** The cell that ticks one row. The name is what the row is called, so the box has a name. */
export function SelectRowTd({
  selection,
  id,
  name,
}: {
  selection: Selection;
  id: string;
  name: string;
}) {
  return (
    <Td className="w-10 pr-0">
      <Checkbox
        hideLabel
        label={t('bulk.selectRow', { name })}
        checked={selection.isSelected(id)}
        onChange={() => selection.toggle(id)}
      />
    </Td>
  );
}
