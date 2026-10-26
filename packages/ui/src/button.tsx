import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

/*
 * One primary action per view. `primary` is the only filled teal in the
 * product, so when it appears it is the answer to "what do I do here?";
 * `outline` is the working default for everything else, sitting on white so it
 * reads as a control rather than as a label.
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/80',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/70',
  destructive:
    'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/80',
  outline:
    'border border-input bg-card text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-accent/70',
};

const SIZES: Record<Size, string> = {
  xs: 'h-7 gap-1 rounded-md px-2 text-xs',
  sm: 'h-8 gap-1.5 rounded-md px-3 text-sm',
  md: 'h-9 gap-2 rounded-md px-3.5 text-sm',
  lg: 'h-11 gap-2 rounded-md px-5 text-base',
  icon: 'h-9 w-9 rounded-md',
  'icon-sm': 'h-8 w-8 rounded-md',
};

/**
 * The classes of a button, for the one case `Button` cannot cover: a link that
 * should look like one. Navigation is a link, not a `<button>`, because it must
 * work with a middle-click and be announced as a link — but it should not have to
 * re-derive the look and drift from it.
 */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  className,
}: { variant?: Variant; size?: Size; className?: string | undefined } = {}): string {
  return cn(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium',
    'transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // aria-busy rather than only a spinner: a screen reader user needs to know
      // the action is in flight, not just sighted users.
      aria-busy={loading || undefined}
      disabled={disabled === true || loading}
      className={buttonStyles({ variant, size, className })}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

/**
 * A button that is only an icon.
 *
 * `label` is required and becomes the accessible name, because an icon alone
 * tells a screen-reader user nothing. It is also the `title`, so a sighted
 * mouse user gets the same words on hover.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'children' | 'aria-label'> & { label: string; icon: ReactNode }
>(function IconButton({ label, icon, size = 'icon', variant = 'ghost', ...props }, ref) {
  return (
    <Button ref={ref} variant={variant} size={size} aria-label={label} title={label} {...props}>
      {icon}
    </Button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
