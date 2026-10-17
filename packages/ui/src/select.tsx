import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from './cn.js';

/**
 * A labelled select, built on the native element.
 *
 * In the design system rather than in the one screen that first needed it
 * (CLAUDE.md §9): the second screen to want a dropdown must find one here, not
 * copy a styled `<select>` that then drifts.
 *
 * Native on purpose. A custom listbox would have to re-implement keyboard
 * handling, typeahead and the platform's own picker on a phone, and every one
 * of those is somewhere accessibility quietly breaks. When a dropdown needs
 * search or multi-select, that is a different component next to this one, not
 * a rewrite of it.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Required, like `Input`'s: every control gets a label (CLAUDE.md §9). */
  label: string;
  labelHidden?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, label, labelHidden = false, error, hint, id, children, ...props },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;
  const hintId = `${selectId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={selectId}
        className={cn('text-sm font-medium text-foreground', labelHidden && 'sr-only')}
      >
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={
          cn(error !== undefined && errorId, hint !== undefined && hintId) || undefined
        }
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error !== undefined && 'border-destructive',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {hint !== undefined ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});
