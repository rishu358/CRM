'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@crm/ui';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * The application frame: sidebar, header, content.
 *
 * Objects not yet built are shown but disabled, so the shape of the product is
 * visible without pretending a link works.
 */
const NAV: readonly { href: string; label: TranslationKey; ready: boolean }[] = [
  { href: '/contacts', label: 'nav.contacts', ready: true },
  { href: '/accounts', label: 'nav.accounts', ready: false },
  { href: '/deals', label: 'nav.deals', ready: false },
  { href: '/settings', label: 'nav.settings', ready: false },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label={t('app.name')}
        className="hidden w-56 shrink-0 border-r border-border bg-card p-4 md:block"
      >
        <div className="mb-6 px-2 text-sm font-semibold tracking-tight">{t('app.name')}</div>
        <ul className="space-y-1">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                {item.ready ? (
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    {t(item.label)}
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className="block cursor-not-allowed rounded-md px-3 py-2 text-sm text-muted-foreground/50"
                  >
                    {t(item.label)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
