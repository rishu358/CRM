import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Required, like every control's: it is the thing a screen reader announces. */
  label: ReactNode;
  /** What the choice means, in a sentence, tied to the control with `aria-describedby`. */
  description?: ReactNode;
}

/**
 * A labelled radio button, the sibling of `Checkbox`: the whole row is the label, the dot uses the
 * system's `--primary`, and its edge is the control border that `contrast.test.ts` holds to 3:1.
 * Group radios with the same `name` inside a `fieldset` and a `legend`.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, description, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;

  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        ref={ref}
        id={inputId}
        type="radio"
        aria-describedby={description === undefined ? undefined : descriptionId}
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 cursor-pointer border border-input bg-card accent-primary',
          'transition-colors duration-fast hover:border-foreground/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={inputId} className="cursor-pointer text-sm text-foreground">
          {label}
        </label>
        {description === undefined ? null : (
          <p id={descriptionId} className="mt-0.5 text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
});
