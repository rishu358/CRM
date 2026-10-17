'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  NoPermissionState,
  Skeleton,
} from '@crm/ui';
import Link from 'next/link';
import { useMemo } from 'react';
import {
  browserTimeZone,
  useMyDay,
  useUpdateActivity,
  type ActivityRecord,
  type LinkTargetType,
} from '../lib/activities';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
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
 */
export function MyDayScreen() {
  const timeZone = useMemo(() => browserTimeZone(), []);
  const query = useMyDay(timeZone);
  const update = useUpdateActivity();

  if (query.isPending) {
    return (
      <AppShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
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
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">{t('myDay.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('myDay.subtitle', { date: day.date, timeZone: day.timeZone })}
        </p>
      </header>

      {nothingDue ? (
        <EmptyState
          title={t('myDay.empty.title')}
          description={t('myDay.empty.description')}
          action={
            <Link href="/contacts">
              <Button variant="outline">{t('myDay.empty.action')}</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          <Bucket
            heading={t('myDay.overdue')}
            tone="destructive"
            activities={day.overdue}
            onComplete={complete}
          />
          <Bucket heading={t('myDay.dueToday')} activities={day.dueToday} onComplete={complete} />
          <Bucket heading={t('myDay.upcoming')} activities={day.upcoming} onComplete={complete} />
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title={t('myDay.recentlyViewed')} />
        <CardBody>
          {day.recentlyViewed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('myDay.recentlyViewed.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {day.recentlyViewed.map((item) => (
                <li key={`${item.objectType}:${item.recordId}`} className="text-sm">
                  <Link
                    href={`${pathFor(item.objectType)}/${item.recordId}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {item.label}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {formatDateTime(item.viewedAt, DEFAULT_PREFERENCES)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
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
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {heading}
            <Badge tone={tone === 'destructive' ? 'destructive' : 'neutral'}>
              {activities.length}
            </Badge>
          </span>
        }
      />
      <CardBody>
        <ul className="divide-y divide-border">
          {activities.map((activity) => (
            <li key={activity.id} className="flex items-start gap-3 py-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                checked={activity.status === 'completed'}
                aria-label={t('activities.complete', { subject: activity.subject ?? '' })}
                onChange={() => onComplete(activity)}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{activity.subject}</p>
                {activity.dueAt != null ? (
                  <p className="text-sm text-muted-foreground">
                    {t('activities.due', {
                      when: formatDateTime(activity.dueAt, DEFAULT_PREFERENCES),
                    })}
                  </p>
                ) : null}
                {activity.links !== undefined && activity.links.length > 0 ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {activity.links.map((link) => (
                      <Link
                        key={`${link.objectType}:${link.recordId}`}
                        href={`${pathFor(link.objectType)}/${link.recordId}`}
                        className="mr-2 underline-offset-4 hover:underline"
                      >
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
