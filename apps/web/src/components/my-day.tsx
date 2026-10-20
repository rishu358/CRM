'use client';

import {
  AccountsIcon,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  ContactsIcon,
  DealsIcon,
  DueIcon,
  EmptyState,
  ErrorState,
  LeadsIcon,
  NoPermissionState,
  PageHeader,
  Skeleton,
  SuccessIcon,
  buttonStyles,
  cn,
} from '@crm/ui';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import {
  browserTimeZone,
  useMyDay,
  useUpdateActivity,
  type ActivityRecord,
  type LinkTargetType,
} from '../lib/activities';
import { DEFAULT_PREFERENCES, formatDate, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';

/**
 * My Day: what this person has to do, and what they were just looking at
 * (MVP_SPEC M6).
 *
 * The buckets are cut by the **server**, in the viewer's time zone, which the
 * browser reports here. Doing the bucketing client-side would mean fetching
 * every open task to sort three lists, and doing it in UTC would silently
 * move work between days for everyone who is not on UTC.
 *
 * Overdue leads, because it is the only bucket that is a problem: it gets the
 * one red accent on the page, and the others stay neutral so that red means
 * "this was due and is not done" and nothing else.
 */
export function MyDayScreen() {
  const timeZone = useMemo(() => browserTimeZone(), []);
  const query = useMyDay(timeZone);
  const update = useUpdateActivity();

  if (query.isPending) {
    return (
      <AppShell>
        <div className="space-y-5">
          <Skeleton className="h-8 w-40" />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-6">
              <CardSkeleton rows={3} label={t('common.loading')} />
              <CardSkeleton rows={3} label={t('common.loading')} />
            </div>
            <CardSkeleton rows={4} label={t('common.loading')} />
          </div>
        </div>
      </AppShell>
    );
  }

  if (query.isError) {
    return (
      <AppShell>
        {query.error.status === 403 ? (
          <NoPermissionState
            title={t('myDay.forbidden.title')}
            description={t('myDay.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('myDay.error.title')}
            description={t('myDay.error.description')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </AppShell>
    );
  }

  const day = query.data.data;
  const nothingDue =
    day.overdue.length === 0 && day.dueToday.length === 0 && day.upcoming.length === 0;

  const complete = (activity: ActivityRecord) => {
    update.mutate({
      id: activity.id,
      version: activity.version,
      patch: { status: activity.status === 'completed' ? 'open' : 'completed' },
    });
  };

  return (
    <AppShell>
      <PageHeader
        title={t('myDay.title')}
        description={t('myDay.subtitle', {
          date: formatDate(day.date, DEFAULT_PREFERENCES),
          timeZone: day.timeZone,
        })}
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {nothingDue ? (
            <EmptyState
              icon={<SuccessIcon className="h-5 w-5" />}
              title={t('myDay.empty.title')}
              description={t('myDay.empty.description')}
              action={
                <Link href="/contacts" className={buttonStyles({ variant: 'outline' })}>
                  {t('myDay.empty.action')}
                </Link>
              }
            />
          ) : (
            <>
              <Bucket
                heading={t('myDay.overdue')}
                tone="destructive"
                activities={day.overdue}
                onComplete={complete}
              />
              <Bucket
                heading={t('myDay.dueToday')}
                activities={day.dueToday}
                onComplete={complete}
              />
              <Bucket
                heading={t('myDay.upcoming')}
                activities={day.upcoming}
                onComplete={complete}
              />
            </>
          )}
        </div>

        <Card>
          <CardHeader title={t('myDay.recentlyViewed')} />
          <CardBody className="p-2">
            {day.recentlyViewed.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{t('myDay.recentlyViewed.empty')}</p>
            ) : (
              <ul>
                {day.recentlyViewed.map((item) => (
                  <li key={`${item.objectType}:${item.recordId}`}>
                    <Link
                      href={`${pathFor(item.objectType)}/${item.recordId}`}
                      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-fast hover:bg-accent/60"
                    >
                      <span aria-hidden="true" className="text-muted-foreground">
                        {iconFor(item.objectType)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                      <span className="figures shrink-0 text-xs text-muted-foreground">
                        {formatDateTime(item.viewedAt, DEFAULT_PREFERENCES)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </AppShell>
  );
}

function Bucket({
  heading,
  activities,
  tone = 'neutral',
  onComplete,
}: {
  heading: string;
  activities: ActivityRecord[];
  tone?: 'neutral' | 'destructive';
  onComplete: (activity: ActivityRecord) => void;
}) {
  if (activities.length === 0) return null;

  return (
    <Card className={cn(tone === 'destructive' && 'border-destructive/40')}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {heading}
            <Badge tone={tone === 'destructive' ? 'destructive' : 'neutral'}>
              <span className="figures">{activities.length}</span>
            </Badge>
          </span>
        }
      />
      <CardBody className="px-5 py-1">
        <ul className="divide-y divide-border">
          {activities.map((activity) => (
            <li key={activity.id} className="flex items-start gap-3 py-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 cursor-pointer"
                checked={activity.status === 'completed'}
                aria-label={t('activities.complete', { subject: activity.subject ?? '' })}
                onChange={() => onComplete(activity)}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'font-medium',
                    activity.status === 'completed' && 'text-muted-foreground line-through',
                  )}
                >
                  {activity.subject}
                </p>
                {activity.dueAt != null ? (
                  <p
                    className={cn(
                      'figures mt-0.5 flex items-center gap-1.5 text-sm',
                      tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    <DueIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('activities.due', {
                      when: formatDateTime(activity.dueAt, DEFAULT_PREFERENCES),
                    })}
                  </p>
                ) : null}
                {activity.links !== undefined && activity.links.length > 0 ? (
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    {activity.links.map((link) => (
                      <Link
                        key={`${link.objectType}:${link.recordId}`}
                        href={`${pathFor(link.objectType)}/${link.recordId}`}
                        className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground transition-colors duration-fast hover:bg-accent hover:text-accent-foreground"
                      >
                        <span aria-hidden="true">{iconFor(link.objectType)}</span>
                        {link.label}
                      </Link>
                    ))}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function iconFor(objectType: LinkTargetType): ReactNode {
  const className = 'h-3.5 w-3.5';
  switch (objectType) {
    case 'account':
      return <AccountsIcon className={className} />;
    case 'lead':
      return <LeadsIcon className={className} />;
    case 'deal':
      return <DealsIcon className={className} />;
    case 'contact':
      return <ContactsIcon className={className} />;
  }
}

function pathFor(objectType: LinkTargetType): string {
  switch (objectType) {
    case 'account':
      return '/accounts';
    case 'lead':
      return '/leads';
    case 'deal':
      return '/deals';
    case 'contact':
      return '/contacts';
  }
}
