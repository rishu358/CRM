import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn.js';
import { SearchIcon } from './icons.js';

/**
 * The look of every text control, in one place so an input, a select and a
 * textarea cannot drift apart. The border is `--input`, not `--border`: it is
 * the visible edge of a control, and WCAG 1.4.11 asks for 3:1 against the
 * surface behind it (checked in `contrast.test.ts`).
 */
export const CONTROL =
  'w-full rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-sm ' +
  'placeholder:text-muted-foreground transition-colors duration-fast ' +
  'hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-[invalid=true]:border-destructive';

/** Label + control + hint + error, wired together with the right ARIA. */
export function Field({
  id,
  label,
  labelHidden = false,
  error,
  hint,
  children,
  className,
}: {
  id: string;
  label: string;
  labelHidden?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cn('text-sm font-medium text-foreground', labelHidden && 'sr-only')}
      >
        {label}
      </label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        // role="alert" so the message is announced when it appears, not only
        // when the field happens to be focused.
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error: string | undefined, hint: string | undefined) {
  return cn(error !== undefined && `${id}-error`, hint !== undefined && `${id}-hint`) || undefined;
}

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
  /** Classes for the box around label, control and message — where width goes. */
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, wrapperClassName, label, labelHidden = false, error, hint, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <Field
      id={inputId}
      label={label}
      labelHidden={labelHidden}
      error={error}
      hint={hint}
      {...(wrapperClassName === undefined ? {} : { className: wrapperClassName })}
    >
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(inputId, error, hint)}
        className={cn(CONTROL, 'h-9 py-1', className)}
        {...props}
      />
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  labelHidden?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, label, labelHidden = false, error, hint, id, rows = 3, ...props },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;

  return (
    <Field id={textareaId} label={label} labelHidden={labelHidden} error={error} hint={hint}>
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(textareaId, error, hint)}
        className={cn(CONTROL, 'resize-y py-2', className)}
        {...props}
      />
    </Field>
  );
});

/**
 * A search box: a native `type="search"` input (so it keeps its `searchbox`
 * role, its clear affordance and mobile keyboard) with a magnifier inside it.
 * The label is always present for assistive technology and hidden by default,
 * because the placeholder and the icon already say what it is for.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'type' | 'error' | 'hint'> & { wrapperClassName?: string }
>(function SearchField(
  { className, wrapperClassName, label, labelHidden = true, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      <label
        htmlFor={inputId}
        className={cn('text-sm font-medium text-foreground', labelHidden && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={ref}
          id={inputId}
          type="search"
          className={cn(CONTROL, 'h-9 py-1 pl-8', className)}
          {...props}
        />
      </div>
    </div>
  );
});
