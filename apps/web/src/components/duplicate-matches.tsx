'use client';

import Link from 'next/link';
import type { DuplicateMatch } from '../lib/leads';
import { t, type TranslationKey } from '../lib/i18n';

/** Where each kind of match lives. */
const ROUTES = { lead: '/leads', contact: '/contacts', account: '/accounts' } as const;

/**
 * The records a new lead or a conversion might duplicate, and why each matched.
 *
 * Shared by the create prompt and the conversion dialog so both say the same
 * thing in the same words. The label arrives already filtered to what the
 * viewer may read, so nothing here decides what is safe to show.
 */
export function DuplicateMatches({ matches }: { matches: readonly DuplicateMatch[] }) {
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="duplicate-matches"
    >
      {matches.map((match) => (
        <li
          key={`${match.objectType}-${match.id}`}
          className="flex items-center justify-between gap-3 p-3 text-sm"
        >
          <div className="min-w-0">
            <Link
              href={`${ROUTES[match.objectType]}/${match.id}`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {match.label}
            </Link>
            <span className="ml-2 text-xs text-muted-foreground">
              {t(`duplicate.type.${match.objectType}` as TranslationKey)}
            </span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {match.matchedOn
              .map((reason) => t(`duplicate.reason.${reason}` as TranslationKey))
              .join(', ')}
          </span>
        </li>
      ))}
    </ul>
  );
}
