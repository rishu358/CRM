import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from './cn.js';
import { ChevronDownIcon } from './icons.js';
import { CONTROL, Field } from './input.js';

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
 * a rewrite of it. Only the chevron is ours, so it matches the other controls.
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

  return (
    <Field id={selectId} label={label} labelHidden={labelHidden} error={error} hint={hint}>
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={
            cn(
              error !== undefined && `${selectId}-error`,
              hint !== undefined && `${selectId}-hint`,
            ) || undefined
          }
          className={cn(CONTROL, 'h-9 cursor-pointer appearance-none py-1 pr-8', className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    </Field>
  );
});

/**
 * A select that looks like an icon button.
 *
 * The real `<select>` is laid over the icon at zero opacity, so it keeps
 * everything native — the label, the keyboard, typeahead, the phone's own
 * picker — while the eye sees a small, quiet control. The icon draws the hover
 * and focus states from the select via `peer`, so focus is visible on the thing
 * that is actually focused.
 *
 * For the places a full-width dropdown would be a column of identical grey boxes
 * (a "move to stage" menu on every card of a board).
 */
export const IconSelect = forwardRef<
  HTMLSelectElement,
  Omit<SelectProps, 'labelHidden' | 'error' | 'hint'> & { icon: ReactNode }
>(function IconSelect({ className, label, id, icon, children, ...props }, ref) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={cn('relative h-7 w-7 shrink-0', className)}>
      <label htmlFor={selectId} className="sr-only">
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none opacity-0"
        {...props}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none flex h-full w-full items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast',
          'peer-hover:bg-accent peer-hover:text-accent-foreground',
          'peer-focus-visible:bg-accent peer-focus-visible:text-accent-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
        )}
      >
        {icon}
      </span>
    </div>
  );
});
