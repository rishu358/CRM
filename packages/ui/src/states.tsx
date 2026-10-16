import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * The four states every screen must handle (CLAUDE.md §9).
 *
 * Shipped as components rather than left to each page, because "every screen
 * handles loading, empty, error and no-permission" only holds if doing it is
 * easier than not doing it.
 */

/** Skeleton placeholder. Matches the shape of what is loading, not a spinner. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-9 flex-1" />
          ))}
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
}

export function EmptyState({ title, description, action, icon }: StateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-12 text-center">
      {icon}
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description !== undefined ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

export function ErrorState({ title, description, action }: StateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-12 text-center"
    >
      <h2 className="text-base font-semibold text-destructive">{title}</h2>
      {description !== undefined ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * Shown when the API refuses the request.
 *
 * Note this is cosmetic: hiding a screen is never the enforcement. The API
 * decided, and this just explains the decision (CLAUDE.md §9).
 */
export function NoPermissionState({ title, description }: StateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/30 p-12 text-center">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description !== undefined ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
