import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';
import { CloseIcon } from './icons.js';

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

/** The colours a tag may carry, by name. Mirrors `TAG_COLORS` in `@crm/core`, which this package does not import. */
export type TagChipColor =
  'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'violet';

/**
 * The dot of each colour. Literal class names, so the stylesheet generator can see every one of them;
 * built from the name they would be dropped from the build.
 */
const TAG_DOT: Record<TagChipColor, string> = {
  gray: 'bg-slate-500 dark:bg-slate-400',
  red: 'bg-red-600 dark:bg-red-400',
  orange: 'bg-orange-600 dark:bg-orange-400',
  amber: 'bg-amber-600 dark:bg-amber-400',
  green: 'bg-green-600 dark:bg-green-400',
  teal: 'bg-teal-600 dark:bg-teal-400',
  blue: 'bg-blue-600 dark:bg-blue-400',
  violet: 'bg-violet-600 dark:bg-violet-400',
};

/**
 * A tag on a record: its name on the page's own secondary surface, with its colour as a dot.
 *
 * The text sits on `secondary`, a pair `contrast.test.ts` proves in both themes, so no colour a person
 * picks can make a name unreadable. Colour alone never carries the meaning (WCAG 1.4.1): the name is
 * the tag, and the dot is only a way to spot it faster, which is why it is hidden from assistive technology.
 * Pass `onRemove` for the chip in an editor; the button is named by `removeLabel`, as this package has no i18n.
 */
export function TagChip({
  name,
  color,
  onRemove,
  removeLabel,
  className,
}: {
  name: string;
  color?: TagChipColor | null | undefined;
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5',
        'text-xs font-medium leading-4 text-secondary-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          color === null || color === undefined ? 'bg-muted-foreground/60' : TAG_DOT[color],
        )}
      />
      <span className="truncate">{name}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? name}
          className={cn(
            '-mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            'text-muted-foreground transition-colors duration-fast hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
