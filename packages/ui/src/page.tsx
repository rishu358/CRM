import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * The top of every screen: what this is, what it is about, and the one thing
 * you most likely came to do.
 *
 * The page title is the only `h1` on a screen. It is set larger and tighter than
 * anything beneath it, so the eye lands on "where am I" first. Primary actions
 * go in `actions`, on the right, with the primary one last — the place the eye
 * ends up after reading left to right.
 */
export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Sits beside the title: a status badge, a count. */
  meta?: ReactNode;
  /** A "back to the list" link, above the title. */
  back?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn('mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}
    >
      <div className="min-w-0">
        {back === undefined ? null : <div className="mb-2 text-sm">{back}</div>}
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-2xl font-semibold">{title}</h1>
          {meta}
        </div>
        {description === undefined ? null : (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/**
 * The row of controls between the header and the content: search and filters on
 * the left, secondary actions on the right. Separate from `PageHeader` because
 * they answer a different question — "what am I looking at?" versus "what do I
 * do to this list?" — and mixing them is how a toolbar ends up with eight
 * equally loud buttons.
 */
export function Toolbar({
  start,
  end,
  className,
}: {
  start?: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="flex min-w-0 flex-wrap items-end gap-2">{start}</div>
      <div className="flex flex-wrap items-center gap-2">{end}</div>
    </div>
  );
}

/** A small row under a list: the count on the left, paging on the right. */
export function ListFooter({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
      <span aria-live="polite" className="figures">
        {children}
      </span>
      {end}
    </div>
  );
}
