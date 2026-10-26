'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DealsIcon,
  DueIcon,
  EmptyState,
  ErrorState,
  LeadsIcon,
  NoPermissionState,
  PageHeader,
  Skeleton,
  SuccessIcon,
  WonIcon,
  buttonStyles,
  cn,
} from '@crm/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ApiRequestError, ItemEnvelope } from '../lib/api-client';
import {
  useDashboardLeaderboard,
  useDashboardLeads,
  useDashboardOverdue,
  useDashboardPipeline,
  useDashboardWon,
  type DashboardWon,
} from '../lib/dashboard';
import { DEFAULT_PREFERENCES, formatCount, formatDateTime, formatMoney } from '../lib/format';
import { t, tPlural } from '../lib/i18n';
import { useOnboarding } from '../lib/onboarding';
import { AppShell } from './app-shell';
import { SetupChecklist } from './setup-checklist';

/**
 * The home dashboard (MVP_SPEC M10).
 *
 * Every card is its own query and its own set of states, because the API
 * authorizes one widget at a time: a role that may read leads but not deals sees
 * a working leads card beside a "no access" pipeline card, never a blank page.
 * The four headline figures read the same queries as the cards below them, so
 * the number at the top and the chart under it cannot disagree.
 *
 * What this file never does is decide what a person may see. A 403 is the
 * answer; a `null` inside a 200 means a field is hidden from the role, and is
 * said so in words rather than drawn as a zero (ADR-0038).
 */
export function DashboardScreen() {
  const won = useDashboardWon();
  const pipeline = useDashboardPipeline();
  const leads = useDashboardLeads();
  const overdue = useDashboardOverdue();
  const onboarding = useOnboarding();

  const checklist = onboarding.data?.data.checklist;
  const unfinished = checklist !== undefined && checklist.some((item) => !item.done);

  return (
    <AppShell>
      <PageHeader
        title={t('dashboard.title')}
        description={won.data === undefined ? undefined : monthLabel(won.data.data)}
      />

      <div className="space-y-6">
        {unfinished ? <SetupChecklist checklist={checklist} /> : null}

        <section
          aria-label={t('dashboard.title')}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <WonFigure query={won} />
          <Figure
            label={t('dashboard.pipeline.title')}
            icon={<DealsIcon className="h-4 w-4" />}
            query={pipeline}
            render={(data) =>
              data.open.total === null
                ? {
                    value: formatCount(data.open.count, DEFAULT_PREFERENCES),
                    hint: t('dashboard.amountHidden'),
                  }
                : {
                    value: formatMoney(
                      data.open.total.amountMinor,
                      data.open.total.currency,
                      DEFAULT_PREFERENCES,
                    ),
                    hint: tPlural('dashboard.pipeline.deals', data.open.count),
                  }
            }
          />
          <Figure
            label={t('dashboard.leads.title')}
            icon={<LeadsIcon className="h-4 w-4" />}
            query={leads}
            render={(data) =>
              data.total === null
                ? null
                : {
                    value: formatCount(data.total, DEFAULT_PREFERENCES),
                    hint: t('dashboard.leads.hint'),
                  }
            }
          />
          <Figure
            label={t('dashboard.overdue.title')}
            icon={<DueIcon className="h-4 w-4" />}
            query={overdue}
            tone={(data) => (data.count !== null && data.count > 0 ? 'alert' : 'calm')}
            render={(data) =>
              data.count === null
                ? null
                : {
                    value: formatCount(data.count, DEFAULT_PREFERENCES),
                    hint:
                      data.count === 0
                        ? t('dashboard.overdue.empty.title')
                        : t('dashboard.overdue.hint'),
                  }
            }
          />
        </section>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PipelineCard />
          <LeaderboardCard />
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <LeadsCard />
          <OverdueCard />
        </div>
      </div>
    </AppShell>
  );
}

/** "October 2026 · Asia/Kolkata": the calendar the month figures were cut on. */
function monthLabel(data: DashboardWon): string {
  const month = new Intl.DateTimeFormat(DEFAULT_PREFERENCES.locale, {
    month: 'long',
    year: 'numeric',
    timeZone: data.timeZone,
  }).format(new Date(data.month.start));
  return t('dashboard.subtitle', { month, timeZone: data.timeZone });
}

type Query<T> = UseQueryResult<ItemEnvelope<T>, ApiRequestError>;

/* ------------------------------------------------------------------------- */
/* Headline figures                                                          */
/* ------------------------------------------------------------------------- */

interface FigureView {
  readonly value: string;
  readonly hint?: string | undefined;
  readonly badge?: ReactNode;
}

function FigureShell({
  label,
  icon,
  tone = 'calm',
  children,
}: {
  label: string;
  icon: ReactNode;
  tone?: 'calm' | 'alert';
  children: ReactNode;
}) {
  return (
    <Card className={cn(tone === 'alert' && 'border-destructive/40')}>
      <CardBody className="space-y-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span aria-hidden="true" className={cn(tone === 'alert' && 'text-destructive')}>
            {icon}
          </span>
          {label}
        </p>
        {children}
      </CardBody>
    </Card>
  );
}

/** The one-line answer when a figure cannot be shown, by *why* it cannot. */
function figureProblem(query: Query<unknown>): string | null {
  if (!query.isError) return null;
  return query.error.status === 403 ? t('dashboard.forbidden.title') : t('dashboard.error.title');
}

function Figure<T>({
  label,
  icon,
  query,
  render,
  tone,
}: {
  label: string;
  icon: ReactNode;
  query: Query<T>;
  /** Null means a hidden field makes the figure impossible to show. */
  render: (data: T) => FigureView | null;
  tone?: (data: T) => 'calm' | 'alert';
}) {
  const problem = figureProblem(query);
  const data = query.data?.data;
  const view = data === undefined ? null : render(data);

  return (
    <FigureShell
      label={label}
      icon={icon}
      tone={data !== undefined && tone !== undefined ? tone(data) : 'calm'}
    >
      {query.isPending ? (
        <div role="status" aria-label={t('dashboard.loading')} className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : problem !== null ? (
        <p className="text-sm text-muted-foreground">{problem}</p>
      ) : view === null ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.unavailable.title')}</p>
      ) : (
        <>
          <p className="figures text-2xl font-semibold tracking-tight">{view.value}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {view.badge}
            {view.hint}
          </p>
        </>
      )}
    </FigureShell>
  );
}

/**
 * Won this month, set against last month.
 *
 * The comparison is the point of the card: a total alone cannot tell somebody
 * whether the month is going well. It says nothing rather than something
 * misleading when there is nothing to compare — a month that follows an empty
 * one has no percentage, not an infinite one.
 */
function WonFigure({ query }: { query: Query<DashboardWon> }) {
  return (
    <Figure
      label={t('dashboard.won.title')}
      icon={<WonIcon className="h-4 w-4" />}
      query={query}
      render={(data) => {
        const { current, previous } = data;
        if (current === null) return null;

        const count = tPlural('dashboard.won.count', current.count);
        if (current.total === null) {
          return {
            value: formatCount(current.count, DEFAULT_PREFERENCES),
            hint: t('dashboard.amountHidden'),
          };
        }

        const value = formatMoney(
          current.total.amountMinor,
          current.total.currency,
          DEFAULT_PREFERENCES,
        );
        const before = previous?.total;
        if (before === null || before === undefined) return { value, hint: count };

        // A month after an empty one has no percentage to show, not an infinite one.
        if (before.amountMinor === '0') return { value, hint: t('dashboard.won.noComparison') };

        return {
          value,
          hint: t('dashboard.won.lastMonth', {
            total: formatMoney(before.amountMinor, before.currency, DEFAULT_PREFERENCES),
          }),
          badge: (
            <DeltaBadge
              now={BigInt(current.total.amountMinor)}
              before={BigInt(before.amountMinor)}
            />
          ),
        };
      }}
    />
  );
}

function DeltaBadge({ now, before }: { now: bigint; before: bigint }) {
  if (now === before) return <Badge tone="neutral">{t('dashboard.won.same')}</Badge>;

  // Basis points, as integers, so a very large total cannot lose its low digits.
  const basisPoints = Number(((now - before) * 10_000n) / before);
  const percent = new Intl.NumberFormat(DEFAULT_PREFERENCES.locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(Math.abs(basisPoints) / 10_000);
  const up = now > before;

  return (
    <Badge tone={up ? 'success' : 'warning'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="figures">
        {t(up ? 'dashboard.won.up' : 'dashboard.won.down', { percent })}
      </span>
    </Badge>
  );
}

/**
 * A source as typed into the system (`walk_in`, `trade-fair`) as words a person would say.
 * Display only: grouping and filtering use the stored value.
 */
function readable(source: string): string {
  const words = source.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------------- */
/* Detail cards                                                              */
/* ------------------------------------------------------------------------- */

/**
 * A card whose content is one widget, with every state the page promises:
 * loading, no access, failure with a retry, and (via the caller) empty.
 */
function WidgetCard<T>({
  id,
  title,
  description,
  actions,
  query,
  children,
}: {
  /** Names the card for tests and for anchors: `widget-<id>`. */
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  query: Query<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <Card data-testid={`widget-${id}`}>
      <CardHeader title={title} description={description} actions={actions} />
      <CardBody>
        {query.isPending ? (
          <div role="status" aria-label={t('dashboard.loading')} className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : query.isError ? (
          query.error.status === 403 ? (
            <NoPermissionState
              compact
              title={t('dashboard.forbidden.title')}
              description={t('dashboard.forbidden.description')}
            />
          ) : (
            <ErrorState
              compact
              title={t('dashboard.error.title')}
              description={t('dashboard.error.description')}
              action={
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )
        ) : (
          children(query.data.data)
        )}
      </CardBody>
    </Card>
  );
}

function Unavailable() {
  return (
    <NoPermissionState
      compact
      title={t('dashboard.unavailable.title')}
      description={t('dashboard.unavailable.description')}
    />
  );
}

/** A horizontal bar whose length is `part` of `whole`, with a floor so a small value is still seen. */
function Bar({
  part,
  whole,
  tone = 'primary',
}: {
  part: number;
  whole: number;
  tone?: 'primary' | 'muted';
}) {
  const percent = whole <= 0 ? 0 : Math.max(2, Math.round((part / whole) * 100));
  return (
    <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-secondary">
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-base',
          tone === 'primary' ? 'bg-primary' : 'bg-muted-foreground/50',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function PipelineCard() {
  const query = useDashboardPipeline();

  return (
    <WidgetCard
      id="pipeline"
      title={t('dashboard.pipeline.title')}
      query={query}
      actions={
        <Link href="/deals" className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
          {t('dashboard.pipeline.board')}
        </Link>
      }
    >
      {(data) => {
        if (data.open.count === 0) {
          return (
            <EmptyState
              compact
              icon={<DealsIcon className="h-5 w-5" />}
              title={t('dashboard.pipeline.empty.title')}
              description={t('dashboard.pipeline.empty.description')}
              action={
                <Link href="/deals" className={buttonStyles({ variant: 'outline' })}>
                  {t('dashboard.pipeline.empty.action')}
                </Link>
              }
            />
          );
        }

        // Bars show money when the role may see it, and deal counts when not: the
        // same shape of chart, drawn from what this person is allowed to know.
        const byMoney = data.stages.every((stage) => stage.total !== null);
        const size = (stage: (typeof data.stages)[number]): number =>
          byMoney ? Number(stage.total?.amountMinor ?? 0) : stage.count;
        const largest = Math.max(...data.stages.map(size), 1);

        return (
          <div className="space-y-4">
            <ol className="space-y-3">
              {data.stages.map((stage) => (
                <li key={stage.stageId}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">{stage.name}</span>
                    <span className="figures shrink-0 text-muted-foreground">
                      {tPlural('dashboard.pipeline.deals', stage.count)}
                      {stage.total === null ? null : (
                        <>
                          {' · '}
                          <span className="font-medium text-foreground">
                            {formatMoney(
                              stage.total.amountMinor,
                              stage.total.currency,
                              DEFAULT_PREFERENCES,
                            )}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <Bar
                    part={size(stage)}
                    whole={largest}
                    tone={stage.count === 0 ? 'muted' : 'primary'}
                  />
                </li>
              ))}
            </ol>
            {!byMoney ? (
              <p className="text-sm text-muted-foreground">{t('dashboard.amountHidden')}</p>
            ) : null}
            {data.open.unconverted.length > 0 ? (
              <p role="note" className="text-sm text-warning">
                {t('dashboard.unconverted')}
              </p>
            ) : null}
          </div>
        );
      }}
    </WidgetCard>
  );
}

function LeaderboardCard() {
  const query = useDashboardLeaderboard();

  return (
    <WidgetCard
      id="leaderboard"
      title={t('dashboard.leaderboard.title')}
      description={t('dashboard.leaderboard.description')}
      query={query}
    >
      {(data) => {
        if (data.rows === null) return <Unavailable />;
        if (data.rows.length === 0) {
          return (
            <EmptyState
              compact
              icon={<WonIcon className="h-5 w-5" />}
              title={t('dashboard.leaderboard.empty.title')}
              description={t('dashboard.leaderboard.empty.description')}
            />
          );
        }

        const rows = data.rows;
        const byMoney = data.rankedBy === 'amount';
        const size = (row: (typeof rows)[number]): number =>
          byMoney ? Number(row.total?.amountMinor ?? 0) : row.count;
        const largest = Math.max(...rows.map(size), 1);

        return (
          <ol className="space-y-3">
            {rows.map((row, index) => (
              <li
                key={row.userId}
                className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-3"
              >
                <span
                  aria-label={t('dashboard.leaderboard.rank', { rank: index + 1 })}
                  className={cn(
                    'figures flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold',
                    index === 0
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{row.name}</span>
                      {row.isYou ? (
                        <Badge tone="primary">{t('dashboard.leaderboard.you')}</Badge>
                      ) : null}
                    </span>
                    <span className="figures shrink-0 text-muted-foreground">
                      {row.total === null ? null : (
                        <span className="font-medium text-foreground">
                          {formatMoney(
                            row.total.amountMinor,
                            row.total.currency,
                            DEFAULT_PREFERENCES,
                          )}
                          {' · '}
                        </span>
                      )}
                      {tPlural('dashboard.leaderboard.wins', row.count)}
                      {row.partial ? (
                        <span
                          title={t('dashboard.leaderboard.partial')}
                          aria-label={t('dashboard.leaderboard.partial')}
                          className="ml-1 text-warning"
                        >
                          *
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <Bar part={size(row)} whole={largest} />
                </div>
              </li>
            ))}
          </ol>
        );
      }}
    </WidgetCard>
  );
}

function LeadsCard() {
  const query = useDashboardLeads();

  return (
    <WidgetCard
      id="leads"
      title={t('dashboard.leads.title')}
      description={
        query.data?.data.total == null
          ? undefined
          : tPlural('dashboard.leads.summary', query.data.data.total)
      }
      query={query}
      actions={
        <Link href="/leads" className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
          {t('nav.leads')}
        </Link>
      }
    >
      {(data) => {
        if (data.total === null || data.sources === null) return <Unavailable />;
        if (data.total === 0) {
          return (
            <EmptyState
              compact
              icon={<LeadsIcon className="h-5 w-5" />}
              title={t('dashboard.leads.empty.title')}
              description={t('dashboard.leads.empty.description')}
              action={
                <Link href="/leads" className={buttonStyles({ variant: 'outline' })}>
                  {t('dashboard.leads.empty.action')}
                </Link>
              }
            />
          );
        }

        const rows = [
          ...data.sources.map((group) => ({
            key: group.source ?? '\u0000none',
            label: group.source === null ? t('dashboard.leads.noSource') : readable(group.source),
            count: group.count,
            muted: group.source === null,
          })),
          ...(data.otherCount > 0
            ? [
                {
                  key: '\u0000rest',
                  label: t('dashboard.leads.rest'),
                  count: data.otherCount,
                  muted: true,
                },
              ]
            : []),
        ];
        const largest = Math.max(...rows.map((row) => row.count), 1);

        return (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.key}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span
                    className={cn(
                      'min-w-0 truncate font-medium',
                      row.muted && 'text-muted-foreground',
                    )}
                  >
                    {row.label}
                  </span>
                  <span className="figures shrink-0 text-muted-foreground">
                    {formatCount(row.count, DEFAULT_PREFERENCES)}
                  </span>
                </div>
                <Bar part={row.count} whole={largest} tone={row.muted ? 'muted' : 'primary'} />
              </li>
            ))}
          </ul>
        );
      }}
    </WidgetCard>
  );
}

function OverdueCard() {
  const query = useDashboardOverdue();

  return (
    <WidgetCard
      id="overdue"
      title={t('dashboard.overdue.title')}
      query={query}
      actions={
        <Link href="/my-day" className={buttonStyles({ variant: 'ghost', size: 'sm' })}>
          {t('dashboard.overdue.myDay')}
        </Link>
      }
    >
      {(data) => {
        if (data.count === null) return <Unavailable />;
        if (data.count === 0) {
          return (
            <EmptyState
              compact
              icon={<SuccessIcon className="h-5 w-5" />}
              title={t('dashboard.overdue.empty.title')}
              description={t('dashboard.overdue.empty.description')}
            />
          );
        }

        const more = data.count - data.items.length;
        return (
          <div className="space-y-3">
            <ul className="divide-y divide-border">
              {data.items.map((task) => (
                <li key={task.id} className="py-2.5 first:pt-0">
                  <p className="truncate font-medium">{task.subject}</p>
                  <p className="figures mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    {task.dueAt == null ? null : (
                      <span className="flex items-center gap-1.5 text-destructive">
                        <DueIcon aria-hidden="true" className="h-3.5 w-3.5" />
                        {t('dashboard.overdue.due', {
                          date: formatDateTime(task.dueAt, DEFAULT_PREFERENCES),
                        })}
                      </span>
                    )}
                    {(task.links ?? []).slice(0, 1).map((link) => (
                      <Link
                        key={`${link.objectType}:${link.recordId}`}
                        href={`/${link.objectType}s/${link.recordId}`}
                        className="truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        {link.label}
                      </Link>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
            {more > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('dashboard.overdue.more', { count: formatCount(more, DEFAULT_PREFERENCES) })}
              </p>
            ) : null}
          </div>
        );
      }}
    </WidgetCard>
  );
}
