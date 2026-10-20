import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/** A keyboard key, for shortcut hints. Decorative: pair it with `aria-keyshortcuts`. */
export function Kbd({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1',
        'font-sans text-2xs font-medium leading-none text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

/**
 * Initials in a circle, for a person or a company.
 *
 * Deliberately one colour. Giving every name its own hue looks lively and means
 * nothing — and the palette reserves colour for meaning.
 */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = (
    parts.length > 1
      ? `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`
      : (parts[0]?.slice(0, 2) ?? '')
  ).toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground',
        size === 'sm' && 'h-6 w-6 text-2xs',
        size === 'md' && 'h-8 w-8 text-xs',
        size === 'lg' && 'h-12 w-12 text-base',
        className,
      )}
    >
      {initials}
    </span>
  );
}

/**
 * A read-only label and value, with exactly the geometry of an inline-editable
 * row (label column, top padding, the value's 8px inset). A page that mixes
 * editable and fixed fields — "Created" under "Phone" — reads as one column
 * only if both kinds of row put their text in the same places.
 */
export function DescriptionRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[10rem_1fr] items-start gap-3 py-1', className)}>
      <span className="pt-1.5 text-sm text-muted-foreground">{label}</span>
      <div className="min-w-0 px-2 pt-1.5 text-sm">{children}</div>
    </div>
  );
}
