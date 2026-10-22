import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { QueryProvider } from '../components/query-provider';
import { t } from '../lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  // WCAG 2.4.2: every page has a title that says what it is. Pages set their
  // own and this appends the product name: "Deals · CRM".
  title: { default: t('app.name'), template: `%s · ${t('app.name')}` },
  description: 'Multi-tenant CRM',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request, so each can carry its own CSP nonce (`proxy.ts`).
  // A page built at deploy time has no request to take a nonce from, and its scripts would
  // be refused by the policy it is served with.
  await connection();

  return (
    // suppressHydrationWarning because the theme is resolved from the OS before
    // React hydrates, which legitimately changes the class on the server output.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
