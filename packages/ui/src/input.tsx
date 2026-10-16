import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Required, not optional: every input gets a label (CLAUDE.md §9). Pass
   * `labelHidden` when the design calls for no visible label — the label still
   * exists for assistive technology.
   */
  label: string;
  labelHidden?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, labelHidden = false, error, hint, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className={cn('text-sm font-medium text-foreground', labelHidden && 'sr-only')}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={
          cn(error !== undefined && errorId, hint !== undefined && hintId) || undefined
        }
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
          'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          error !== undefined && 'border-destructive',
          className,
        )}
        {...props}
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        // role="alert" so the message is announced when it appears, not only
        // when the field happens to be focused.
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});
