'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button, cn } from '@crm/ui';
import { t, type TranslationKey } from '../lib/i18n';
import { signOut } from '../lib/session';
import { CommandPalette } from './command-palette';
import { NotificationBell } from './notification-bell';

/**
 * The application frame: sidebar, header, content.
 *
 * Objects not yet built are shown but disabled, so the shape of the product is
 * visible without pretending a link works.
 */
const NAV: readonly { href: string; label: TranslationKey; ready: boolean }[] = [
  { href: '/my-day', label: 'nav.myDay', ready: true },
  { href: '/leads', label: 'nav.leads', ready: true },
  { href: '/contacts', label: 'nav.contacts', ready: true },
  { href: '/accounts', label: 'nav.accounts', ready: true },
  { href: '/deals', label: 'nav.deals', ready: true },
  { href: '/settings/team', label: 'nav.team', ready: true },
  { href: '/settings/security', label: 'nav.settings', ready: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  /**
   * Sign out server-side, then go to the sign-in screen.
   *
   * `/api/session` revokes the session as well as clearing the cookie —
   * dropping the cookie alone would leave a live session that a copied token
   * could still use.
   */
  const leave = async () => {
    await signOut();
    router.push('/sign-in');
    router.refresh();
  };

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

        <div className="mt-6 border-t border-border pt-4">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => void leave()}>
            {t('auth.signOut')}
          </Button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The bell lives in the frame rather than on a page, because a
          notification is about work somewhere else in the app — the point of
          it is to be visible while you are looking at something unrelated.
        */}
        {/*
          The palette lives in the frame for the same reason the bell does:
          it is reached from wherever you happen to be, and `Ctrl`/`Cmd` + `K`
          has to work on every screen rather than on the ones somebody
          remembered to add it to (MVP_SPEC M7).
        */}
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <CommandPalette />
          <NotificationBell />
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
