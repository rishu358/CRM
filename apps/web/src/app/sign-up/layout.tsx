import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';

// The page is a client component, which cannot export metadata; its segment
// layout can. WCAG 2.4.2: the tab says where you are.
export const metadata: Metadata = { title: t('auth.signUp.title') };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
