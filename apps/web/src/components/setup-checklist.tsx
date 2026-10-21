'use client';

import type { ChecklistKey, OnboardingStatus } from '@crm/contracts';
import { Card, CardBody, CardHeader, SuccessIcon, cn } from '@crm/ui';
import Link from 'next/link';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * Where each step is done. The checklist only points: it is derived from what
 * exists on the server (an invitation, a completed import, a deal somebody made),
 * so ticking is never something this component does.
 */
const STEPS: Readonly<
  Record<ChecklistKey, { href: string; title: TranslationKey; hint: TranslationKey }>
> = {
  invite_team: {
    href: '/settings/team',
    title: 'setup.checklist.invite_team',
    hint: 'setup.checklist.invite_team.hint',
  },
  import_contacts: {
    href: '/import',
    title: 'setup.checklist.import_contacts',
    hint: 'setup.checklist.import_contacts.hint',
  },
  add_first_deal: {
    href: '/deals',
    title: 'setup.checklist.add_first_deal',
    hint: 'setup.checklist.add_first_deal.hint',
  },
};

/**
 * "Getting started" (MVP_SPEC M2): the few things that turn an empty workspace
 * into one a team is using.
 *
 * Kept as its own component, taking the status as a prop, so the dashboard can
 * show the same card without a second copy of the list or its wording.
 */
export function SetupChecklist({ checklist }: { checklist: OnboardingStatus['checklist'] }) {
  const done = checklist.filter((item) => item.done).length;
  const total = checklist.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Card data-testid="setup-checklist">
      <CardHeader
        title={t('setup.checklist.title')}
        description={t('setup.checklist.progress', { done, total })}
      />
      <CardBody>
        <div
          role="progressbar"
          aria-label={t('setup.checklist.title')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-valuetext={t('setup.checklist.progress', { done, total })}
          className="mb-4 h-1.5 overflow-hidden rounded-full bg-secondary"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-base"
            style={{ width: `${percent}%` }}
          />
        </div>

        {done === total ? (
          <p className="mb-3 text-sm font-medium text-foreground" role="status">
            {t('setup.checklist.allDone')}
          </p>
        ) : null}

        <ol className="divide-y divide-border">
          {checklist.map((item) => {
            const step = STEPS[item.key];
            return (
              <li key={item.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    item.done
                      ? 'border-transparent bg-transparent text-primary'
                      : 'border-input bg-card',
                  )}
                >
                  {item.done ? <SuccessIcon className="h-5 w-5" /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={step.href}
                    data-testid={`checklist-${item.key}`}
                    data-done={item.done ? 'true' : 'false'}
                    className={cn(
                      'text-sm font-medium hover:underline',
                      item.done ? 'text-muted-foreground line-through' : 'text-foreground',
                    )}
                  >
                    {t(step.title)}
                    <span className="sr-only">
                      {' — '}
                      {item.done ? t('setup.checklist.done') : t('setup.checklist.todo')}
                    </span>
                  </Link>
                  <p className="mt-0.5 text-sm text-muted-foreground">{t(step.hint)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}
