'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  AccessIcon,
  AccountsIcon,
  Button,
  ContactsIcon,
  DealsIcon,
  Dialog,
  IconButton,
  ImportIcon,
  KeyboardIcon,
  Kbd,
  LeadsIcon,
  MenuIcon,
  MyDayIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SecurityIcon,
  SignOutIcon,
  TeamIcon,
  cn,
} from '@crm/ui';
import { useCanManageAccess } from '../lib/access';
import { t, type TranslationKey } from '../lib/i18n';
import { signOut } from '../lib/session';
import { goToKeyFor } from '../lib/shortcuts';
import { useSidebarCollapsed } from '../lib/sidebar';
import { BrandMark } from './brand-mark';
import { CommandPalette } from './command-palette';
import { NotificationBell } from './notification-bell';
import { GlobalShortcuts } from './shortcuts';

/**
 * The application frame: sidebar, top bar, content.
 *
 * Groups are separated by space, not labelled: five work objects, one data tool
 * and two workspace pages are a short list, and a heading over each would
 * spend vertical room to say what the icons already do.
 *
 * The sidebar collapses to an icon rail. A salesperson on a laptop lives on the
 * deal board, and 184px of navigation is the difference between five stages
 * fitting and not. Labels stay in the accessibility tree when collapsed — only
 * their pixels go.
 */
const NAV: readonly {
  href: string;
  label: TranslationKey;
  icon: ReactNode;
  requiresAccessAdmin?: true;
}[][] = [
  [
    { href: '/my-day', label: 'nav.myDay', icon: <MyDayIcon className="h-4 w-4 shrink-0" /> },
    { href: '/leads', label: 'nav.leads', icon: <LeadsIcon className="h-4 w-4 shrink-0" /> },
    {
      href: '/contacts',
      label: 'nav.contacts',
      icon: <ContactsIcon className="h-4 w-4 shrink-0" />,
    },
    {
      href: '/accounts',
      label: 'nav.accounts',
      icon: <AccountsIcon className="h-4 w-4 shrink-0" />,
    },
    { href: '/deals', label: 'nav.deals', icon: <DealsIcon className="h-4 w-4 shrink-0" /> },
  ],
  [{ href: '/import', label: 'nav.import', icon: <ImportIcon className="h-4 w-4 shrink-0" /> }],
  [
    { href: '/settings/team', label: 'nav.team', icon: <TeamIcon className="h-4 w-4 shrink-0" /> },
    {
      href: '/settings/access',
      label: 'nav.access',
      icon: <AccessIcon className="h-4 w-4 shrink-0" />,
      // Only for people the API lets in (`useCanManageAccess`). Cosmetic: the
      // routes behind it refuse everybody else on their own.
      requiresAccessAdmin: true,
    },
    {
      href: '/settings/security',
      label: 'nav.settings',
      icon: <SecurityIcon className="h-4 w-4 shrink-0" />,
    },
  ],
];

function NavList({
  pathname,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const canManageAccess = useCanManageAccess();
  return (
    <div className="space-y-5">
      {NAV.map((group, index) => (
        <ul key={index} className="space-y-0.5">
          {group
            .filter((item) => item.requiresAccessAdmin !== true || canManageAccess)
            .map((item) => {
              const active = pathname.startsWith(item.href);
              const key = goToKeyFor(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? t(item.label) : undefined}
                    {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                    className={cn(
                      'group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-fast',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    {/* The one place teal is structural: where you are. */}
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-2 h-5 w-[3px] rounded-r-full bg-primary"
                      />
                    ) : null}
                    {item.icon}
                    <span className={collapsed ? 'sr-only' : 'flex-1'}>{t(item.label)}</span>
                    {key === undefined || collapsed ? null : (
                      // Revealed on hover or keyboard focus, so the shortcut is
                      // learnable from the control it belongs to without being a
                      // permanent column of letters. Decorative: the dialog lists
                      // every shortcut accessibly.
                      <span
                        aria-hidden="true"
                        className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
                      >
                        <Kbd>G</Kbd>
                        <Kbd>{key.toUpperCase()}</Kbd>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
        </ul>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

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

  const footer = (rail: boolean) => (
    <div className="space-y-1 border-t border-border pt-3">
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'w-full gap-2.5 px-2.5 font-normal text-muted-foreground',
          rail ? 'justify-center px-0' : 'justify-start',
        )}
        onClick={() => setHelpOpen(true)}
        aria-keyshortcuts="?"
        title={rail ? t('shortcuts.open') : undefined}
      >
        <KeyboardIcon className="h-4 w-4 shrink-0" />
        <span className={rail ? 'sr-only' : 'flex-1 text-left'}>{t('shortcuts.open')}</span>
        {rail ? null : <Kbd aria-hidden="true">?</Kbd>}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'w-full gap-2.5 px-2.5 font-normal text-muted-foreground',
          rail ? 'justify-center px-0' : 'justify-start',
        )}
        onClick={() => void leave()}
        title={rail ? t('auth.signOut') : undefined}
      >
        <SignOutIcon className="h-4 w-4 shrink-0" />
        <span className={rail ? 'sr-only' : undefined}>{t('auth.signOut')}</span>
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md"
      >
        {t('common.skipToContent')}
      </a>

      <nav
        aria-label={t('nav.primary')}
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-card pb-3 pt-4 transition-[width] duration-base lg:flex',
          collapsed ? 'w-[3.75rem] px-2' : 'w-60 px-3',
        )}
      >
        <div
          className={cn(
            'mb-6 flex items-center',
            collapsed ? 'flex-col gap-3' : 'justify-between gap-2',
          )}
        >
          <Link
            href="/my-day"
            title={collapsed ? t('app.name') : undefined}
            className="flex items-center gap-2.5 rounded-md px-1 py-1 text-base font-semibold tracking-tight"
          >
            <BrandMark />
            <span className={collapsed ? 'sr-only' : undefined}>{t('app.name')}</span>
          </Link>
          <IconButton
            label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            size="icon-sm"
            className="text-muted-foreground"
            icon={
              collapsed ? (
                <PanelLeftOpenIcon className="h-4 w-4" />
              ) : (
                <PanelLeftCloseIcon className="h-4 w-4" />
              )
            }
            onClick={toggleCollapsed}
          />
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <NavList pathname={pathname} collapsed={collapsed} />
        </div>
        {footer(collapsed)}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The bell lives in the frame rather than on a page, because a
          notification is about work somewhere else in the app — the point of
          it is to be visible while you are looking at something unrelated.
          The palette lives in the frame for the same reason: it is reached
          from wherever you happen to be, and `Ctrl`/`Cmd` + `K` has to work on
          every screen rather than on the ones somebody remembered to add it to
          (MVP_SPEC M7).
        */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-4 lg:px-8">
          <IconButton
            label={t('common.openMenu')}
            icon={<MenuIcon className="h-5 w-5" />}
            className="lg:hidden"
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
          />
          <BrandMark className="mr-1 lg:hidden" />
          <CommandPalette />
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-4 py-6 focus-visible:ring-0 md:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>

      {menuOpen ? (
        <Dialog
          title={t('nav.primary')}
          hideTitle
          closeLabel={t('common.close')}
          onClose={() => setMenuOpen(false)}
          placement="left"
        >
          <div className="flex min-h-[calc(100dvh-7rem)] flex-col gap-6">
            <div className="flex-1">
              <NavList pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            </div>
            {footer(false)}
          </div>
        </Dialog>
      ) : null}

      <GlobalShortcuts helpOpen={helpOpen} onHelpOpenChange={setHelpOpen} />
    </div>
  );
}
