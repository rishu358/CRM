import Link from 'next/link';
import type { ReactNode } from 'react';
import { t } from '../lib/i18n';

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
