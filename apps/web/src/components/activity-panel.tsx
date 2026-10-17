'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@crm/ui';
import { useEffect, useState } from 'react';
import {
  useCreateActivity,
  useRecordActivities,
  useUpdateActivity,
  type ActivityRecord,
  type LinkTargetType,
} from '../lib/activities';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import { NewActivityDialog } from './new-activity-dialog';

/**
 * The activities on one record (MVP_SPEC M6).
 *
 * Rendered by every record page — contacts, accounts, leads and deals —
 * because the panel is about the polymorphic pair, not about any one object
 * (ADR-0005). Which record it is attached to is the only thing that differs.
 *
 * The four states are all here: loading, empty with an action, error, and
 * no-permission, which for this panel means "this user may not read
 * activities" and is a 403 rather than an empty list.
 */
export function ActivityPanel({
  objectType,
  recordId,
}: {
  objectType: LinkTargetType;
  recordId: string;
}) {
  const query = useRecordActivities(objectType, recordId);
  const create = useCreateActivity();
  const update = useUpdateActivity();
  const [composing, setComposing] = useState(false);
  const now = useClock();

  // A caller who may not read activities at all gets 403. Showing an empty
  // list instead would say "no tasks here", which is a different and untrue
  // thing (CLAUDE.md §9).
  if (query.isError && query.error.status === 403) return null;

  const activities = query.data?.data ?? [];

  return (
    <Card className="mt-6">
      <CardHeader
        title={t('activities.title')}
        actions={
          <Button size="sm" onClick={() => setComposing(true)}>
            {t('activities.new')}
          </Button>
        }
      />
      <CardBody>
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title={t('activities.error.title')}
            description={t('activities.error.description')}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : activities.length === 0 ? (
          <EmptyState
            title={t('activities.empty.title')}
            description={t('activities.empty.description')}
            action={
              <Button size="sm" onClick={() => setComposing(true)}>
                {t('activities.empty.action')}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {activities.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                now={now}
                onToggle={(next) => {
                  update.mutate({
                    id: activity.id,
                    version: activity.version,
                    patch: { status: next },
                  });
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>

      {composing ? (
        <NewActivityDialog
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            create.reset();
            setComposing(false);
          }}
          onSubmit={(values) => {
            create.mutate(
              { ...values, links: [{ objectType, recordId }] },
              { onSuccess: () => setComposing(false) },
            );
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * The current time, read after mount and refreshed every minute.
 *
 * Not read during render: the clock is not a pure value, so the server pass
 * and the first client pass would disagree about it. One hook for the whole
 * panel rather than one per row, and it ticks so a task that becomes overdue
 * while the page is open says so.
 */
function useClock(): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const initial = setTimeout(tick, 0);
    const interval = setInterval(tick, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  return now;
}

function ActivityRow({
  activity,
  now,
  onToggle,
}: {
  activity: ActivityRecord;
  now: number | null;
  onToggle: (next: 'open' | 'completed') => void;
}) {
  const completed = activity.status === 'completed';

  /*
   * What the user just clicked, until the server agrees.
   *
   * A controlled checkbox snaps back to the server's value the instant React
   * re-renders, and the round trip — even an optimistic one — takes a tick or
   * two. Holding the intention here keeps the tick on screen the whole time,
   * and it needs no effect to clear: once the server value matches what was
   * clicked, the two agree and this stops mattering.
   */
  const [clicked, setClicked] = useState<boolean | null>(null);
  const checked = clicked === null || clicked === completed ? completed : clicked;

  const overdue =
    !checked && now !== null && activity.dueAt != null && new Date(activity.dueAt).getTime() < now;

  return (
    <li className="flex items-start gap-3 py-3">
      {activity.type !== 'note' ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 rounded border-border"
          checked={checked}
          aria-label={t('activities.complete', { subject: activity.subject ?? '' })}
          onChange={(event) => {
            setClicked(event.target.checked);
            onToggle(event.target.checked ? 'completed' : 'open');
          }}
        />
      ) : (
        <span className="mt-1 w-4 shrink-0" aria-hidden="true" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={checked ? 'text-muted-foreground line-through' : 'font-medium'}>
            {activity.subject}
          </span>
          <Badge tone="neutral">{t(typeLabelKey(activity.type))}</Badge>
          {activity.priority === 'high' ? (
            <Badge tone="warning">{t('activities.priority.high')}</Badge>
          ) : null}
          {overdue ? <Badge tone="destructive">{t('activities.overdue')}</Badge> : null}
        </div>

        {activity.dueAt != null ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('activities.due', {
              when: formatDateTime(activity.dueAt, DEFAULT_PREFERENCES),
            })}
          </p>
        ) : null}

        {activity.body != null && activity.body.length > 0 ? (
          /*
           * The body is HTML the API sanitized with an allow-list on write
           * and again on read (ADR-0024), which is what makes rendering it
           * as markup safe. Nothing else in this app is rendered this way,
           * and nothing should be without the same two passes behind it.
           */
          <div
            className="prose prose-sm mt-1 max-w-none text-sm text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: activity.body }}
          />
        ) : null}

        {activity.links !== undefined && activity.links.length > 1 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('activities.alsoOn', {
              records: activity.links.map((link) => link.label).join(', '),
            })}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function typeLabelKey(type: ActivityRecord['type']) {
  switch (type) {
    case 'call':
      return 'activities.type.call' as const;
    case 'meeting':
      return 'activities.type.meeting' as const;
    case 'note':
      return 'activities.type.note' as const;
    // A caller who may not read `type` gets no `type` at all (CLAUDE.md
    // §5.4), so the undefined case is a permission outcome, not a bug.
    case 'task':
    case undefined:
      return 'activities.type.task' as const;
  }
}
