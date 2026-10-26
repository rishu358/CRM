import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { InboxIcon, LockIcon, WarningIcon } from './icons.js';

/**
 * The four states every screen must handle (CLAUDE.md §9).
 *
 * Shipped as components rather than left to each page, because "every screen
 * handles loading, empty, error and no-permission" only holds if doing it well
 * is easier than not doing it. Each one has a different job:
 *
 *   loading        keep the layout still: a skeleton shaped like the content
 *   empty          explain what belongs here and offer the next action
 *   error          say what happened and what to do about it
 *   no-permission  say whose decision it was, and who can change it
 */

/** Skeleton placeholder. Matches the shape of what is loading, not a spinner. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden="true" />;
}

/**
 * A table-shaped skeleton: a header band, then rows whose cells vary in width,
 * because uniform bars read as a loading spinner and ragged ones read as text.
 * It occupies the same space as the table that replaces it, so nothing jumps.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  label = 'Loading',
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  const widths = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-1/3'];
  return (
    <div
      role="status"
      aria-label={label}
      className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"
    >
      <div className="flex h-9 items-center gap-6 border-b border-border bg-muted px-4">
        {Array.from({ length: columns }, (_, column) => (
          <Skeleton key={column} className="h-2.5 flex-1 opacity-70" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex h-10 items-center gap-6 border-b border-border px-4 last:border-b-0"
        >
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} className="flex-1">
              <Skeleton className={cn('h-3', widths[(row + column * 2) % widths.length])} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A stack of cards, for the screens that are lists of sections rather than tables. */
export function CardSkeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="space-y-4 rounded-lg border border-border bg-card p-5 shadow-sm"
    >
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="grid grid-cols-[9rem_1fr] gap-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className={cn('h-3', row % 2 === 0 ? 'w-2/3' : 'w-1/2')} />
        </div>
      ))}
    </div>
  );
}

export interface StateProps {
  title: string;
  description?: string | undefined;
  /** Every empty state offers the next action: "never a dead end" (UX §4). */
  action?: ReactNode;
  icon?: ReactNode;
  /** Less vertical room, for a state that sits inside a card. */
  compact?: boolean;
}

function StateShell({
  tone,
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: StateProps & { tone: 'neutral' | 'error'; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg px-6 text-center',
        compact ? 'py-8' : 'py-14',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'mb-4 flex h-11 w-11 items-center justify-center rounded-full',
          tone === 'error'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-accent text-accent-foreground',
        )}
      >
        {icon}
      </div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description !== undefined ? (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action === undefined ? null : (
        <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>
      )}
    </div>
  );
}

export function EmptyState({ title, description, action, icon, compact }: StateProps) {
  return (
    <StateShell
      compact={compact ?? false}
      tone="neutral"
      icon={icon ?? <InboxIcon className="h-5 w-5" />}
      title={title}
      description={description}
      action={action}
      className="border border-dashed border-input/60 bg-card/60"
    />
  );
}

export function ErrorState({ title, description, action, icon, compact }: StateProps) {
  return (
    // role="alert": a failure that replaces the content must be announced, not
    // only drawn.
    <div role="alert">
      <StateShell
        compact={compact ?? false}
        tone="error"
        icon={icon ?? <WarningIcon className="h-5 w-5" />}
        title={title}
        description={description}
        action={action}
        className="border border-destructive/30 bg-card"
      />
    </div>
  );
}

/**
 * Shown when the API refuses the request.
 *
 * Note this is cosmetic: hiding a screen is never the enforcement. The API
 * decided, and this just explains the decision (CLAUDE.md §9).
 */
export function NoPermissionState({ title, description, action, icon, compact }: StateProps) {
  return (
    <StateShell
      compact={compact ?? false}
      tone="neutral"
      icon={icon ?? <LockIcon className="h-5 w-5" />}
      title={title}
      description={description}
      action={action}
      className="border border-border bg-muted/50"
    />
  );
}
