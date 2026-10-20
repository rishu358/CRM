import { ArrowLeftIcon } from '@crm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * "Back to the list", above a record's title.
 *
 * A plain link: it is navigation, and `router.back()` would send somebody to
 * wherever they happened to come from — a notification, the palette — rather
 * than to the list this record belongs to.
 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors duration-fast hover:text-foreground"
    >
      <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
      {children}
    </Link>
  );
}
