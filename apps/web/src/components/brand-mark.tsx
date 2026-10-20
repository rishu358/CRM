import { cn } from '@crm/ui';

/**
 * The product mark: three stages narrowing, which is all a pipeline is.
 *
 * Drawn from the theme's own tokens (`fill-primary`, `fill-primary-foreground`),
 * so it is correct in light and dark mode and follows a tenant theme later
 * without a second asset. Decorative: the product name is always beside it.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn('h-7 w-7 shrink-0', className)}
    >
      <rect width="24" height="24" rx="6" className="fill-primary" />
      <rect x="5" y="6" width="14" height="2.6" rx="1.3" className="fill-primary-foreground" />
      <rect
        x="7.5"
        y="10.7"
        width="9"
        height="2.6"
        rx="1.3"
        className="fill-primary-foreground"
        opacity="0.8"
      />
      <rect
        x="10"
        y="15.4"
        width="4"
        height="2.6"
        rx="1.3"
        className="fill-primary-foreground"
        opacity="0.6"
      />
    </svg>
  );
}
