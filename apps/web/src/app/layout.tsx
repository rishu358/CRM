import type { Metadata } from 'next';
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

export default function RootLayout({ children }: { children: ReactNode }) {
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
