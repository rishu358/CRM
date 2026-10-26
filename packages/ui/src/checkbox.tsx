import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Required, like every control's: it is the thing a screen reader announces. */
  label: ReactNode;
  /** What ticking it means, in a sentence, for when the label alone is not enough. */
  description?: ReactNode;
  /**
   * Keep the label for assistive technology but draw only the box: for a checkbox in a table row
   * or a header, where the row itself says what is being ticked.
   */
  hideLabel?: boolean;
}

/**
 * A labelled checkbox.
 *
 * The whole row is the label, so the click target is the sentence and not a
 * sixteen-pixel square. The description is tied to the control with
 * `aria-describedby`, so it is read out with it rather than being decoration
 * beside it. The tick uses the same `--primary` the rest of the system uses, and
 * its edge is the control border that `contrast.test.ts` holds to 3:1.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, hideLabel = false, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;

  return (
    <div className={cn('flex items-start', !hideLabel && 'gap-3', className)}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        aria-describedby={description === undefined ? undefined : descriptionId}
        className={cn(
          hideLabel ? 'mt-0' : 'mt-0.5',
          'h-4 w-4 shrink-0 cursor-pointer rounded border border-input bg-card accent-primary',
          'transition-colors duration-fast hover:border-foreground/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        {...props}
      />
      {hideLabel ? (
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
      ) : (
        <div className="min-w-0">
          <label htmlFor={inputId} className="cursor-pointer text-sm font-medium text-foreground">
            {label}
          </label>
          {description === undefined ? null : (
            <p id={descriptionId} className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
