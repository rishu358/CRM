import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * A surface. White on the tinted page, one hairline and one resting shadow:
 * that single step in lightness is what separates "content" from "page", so
 * nothing nested inside a card needs its own border to be legible.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        {description !== undefined ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'destructive';

/**
 * A status chip. The tone says what kind of fact it is — teal for "active /
 * yours", green for won, amber for waiting, red for lost or overdue — and the
 * text always says it too, because colour alone is not an accessible signal
 * (WCAG 1.4.1).
 */
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-secondary text-secondary-foreground',
    primary: 'bg-primary/15 text-primary',
    success: 'bg-success/15 text-success',
    warning: 'bg-warning/15 text-warning',
    destructive: 'bg-destructive/15 text-destructive',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-4',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
