'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PublicBrand } from '../lib/brand';

/**
 * What this installation calls itself, available to every client component (ADR-0045).
 *
 * The root layout reads the brand from the server's configuration and hands it down here, so no
 * component contains the product name and a deployment changes it without a rebuild. Public values
 * only: `PublicBrand` holds nothing a browser should not see.
 */
const BrandContext = createContext<PublicBrand | null>(null);

export function BrandProvider({ brand, children }: { brand: PublicBrand; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): PublicBrand {
  const brand = useContext(BrandContext);
  if (brand === null) throw new Error('useBrand must be used inside <BrandProvider>');
  return brand;
}
