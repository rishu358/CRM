'use client';

import { cn } from '@crm/ui';
import { useBrand } from './brand-provider';
import { BrandMark } from './brand-mark';

/**
 * The installation's name and mark: its configured logo if there is one, otherwise the built-in
 * mark and the name as text (ADR-0045).
 *
 * A logo is an image of unknown shape, so it is height-bound and never stretched, and its alt text
 * is the name (it is the only thing saying who this is). In the collapsed sidebar there is no room
 * for a wide logo, so that one place falls back to the mark, with the name still read aloud.
 */
export function BrandLockup({
  size,
  collapsed = false,
}: {
  size: 'sidebar' | 'auth';
  collapsed?: boolean;
}) {
  const brand = useBrand();
  const showLogo = brand.logoUrl !== null && !collapsed;

  if (showLogo) {
    return (
      // A plain <img>: the address is configuration and can be any host, which next/image refuses
      // without a per-host allowlist. The CSP allows exactly that host for images (ADR-0045).
      <img
        src={brand.logoUrl ?? undefined}
        alt={brand.name}
        className={cn(
          'w-auto object-contain',
          size === 'auth' ? 'h-10 max-w-[16rem]' : 'h-7 max-w-[10rem]',
        )}
      />
    );
  }

  return (
    <>
      <BrandMark {...(size === 'auth' ? { className: 'h-9 w-9' } : {})} />
      <span
        className={cn(
          size === 'auth' ? 'text-xl font-semibold tracking-tight' : undefined,
          collapsed ? 'sr-only' : undefined,
        )}
      >
        {brand.name}
      </span>
    </>
  );
}
