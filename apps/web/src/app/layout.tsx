import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { BrandProvider } from '../components/brand-provider';
import { QueryProvider } from '../components/query-provider';
import { brandStyle, publicBrand } from '../lib/brand';
import { webEnv } from '../lib/env';
import { t } from '../lib/i18n';
import './globals.css';

/**
 * The page title and icon come from the installation's configuration (ADR-0045), not from the
 * code, so they are resolved per request rather than baked in at build time.
 */
export function generateMetadata(): Metadata {
  const brand = publicBrand(webEnv());
  return {
    // WCAG 2.4.2: every page has a title that says what it is. Pages set their own and this
    // appends the product name: "Deals · Acme CRM".
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: t('app.description'),
    ...(brand.faviconUrl === null ? {} : { icons: { icon: brand.faviconUrl } }),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request, so each can carry its own CSP nonce (`proxy.ts`).
  // A page built at deploy time has no request to take a nonce from, and its scripts would
  // be refused by the policy it is served with.
  await connection();

  const env = webEnv();

  return (
    // suppressHydrationWarning because the theme is resolved from the OS before
    // React hydrates, which legitimately changes the class on the server output.
    // The style attribute carries the brand colours as CSS custom properties (allowed by the
    // CSP's style-src-attr); `styles.css` falls back to its own tokens where there are none.
    <html lang="en" suppressHydrationWarning style={brandStyle(env)}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <BrandProvider brand={publicBrand(env)}>
          <QueryProvider>{children}</QueryProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
