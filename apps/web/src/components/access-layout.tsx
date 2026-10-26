'use client';

import { NoPermissionState, PageHeader, cn } from '@crm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { t, type TranslationKey } from '../lib/i18n';

export type AccessSection = 'people' | 'roles' | 'teams' | 'explorer';

const SECTIONS: readonly { id: AccessSection; href: string; label: TranslationKey }[] = [
  { id: 'people', href: '/settings/access/people', label: 'access.tab.people' },
  { id: 'roles', href: '/settings/access/roles', label: 'access.tab.roles' },
  { id: 'teams', href: '/settings/access/teams', label: 'access.tab.teams' },
  { id: 'explorer', href: '/settings/access/explorer', label: 'access.tab.explorer' },
];

/**
 * The frame every "People & access" screen shares: the header, the section
 * tabs, and the one answer to being refused.
 *
 * The no-permission state here is **cosmetic**. The API refused the request —
 * every route behind these screens is authorized by `can()` — and this only
 * explains the refusal in words (CLAUDE.md §9). Showing it instead of the
 * content is not what keeps anyone out.
 */
export function AccessLayout({
  active,
  title,
  description,
  back,
  meta,
  actions,
  forbidden = false,
  children,
}: {
  active: AccessSection;
  title: ReactNode;
  description?: ReactNode;
  back?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  forbidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(back === undefined ? {} : { back })}
        {...(meta === undefined ? {} : { meta })}
        {...(actions === undefined ? {} : { actions })}
        className="mb-3"
      />

      <nav aria-label={t('access.tabs')} className="mb-6 border-b border-border">
        <ul className="-mb-px flex flex-wrap gap-1">
          {SECTIONS.map((section) => {
            const current = section.id === active;
            return (
              <li key={section.id}>
                <Link
                  href={section.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-10 items-center border-b-2 px-3 text-sm transition-colors duration-fast',
                    current
                      ? 'border-primary font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(section.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {forbidden ? (
        <NoPermissionState
          title={t('access.forbidden.title')}
          description={t('access.forbidden.description')}
        />
      ) : (
        children
      )}
    </div>
  );
}
