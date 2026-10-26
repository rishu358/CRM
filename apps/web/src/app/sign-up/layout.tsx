import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { webEnv } from '../../lib/env';
import { t } from '../../lib/i18n';
import { publicBrand } from '../../lib/brand';

// The page is a client component, which cannot export metadata; its segment
// layout can. WCAG 2.4.2: the tab says where you are.
export const metadata: Metadata = { title: t('auth.signUp.title') };

export default function Layout({ children }: { children: ReactNode }) {
  // A single-tenant installation has no public sign-up (ADR-0046): send anyone who arrives here
  // (an old link, a bookmark) to the sign-in screen. The API refuses sign-up regardless; this is
  // only so that the person is not shown a form that cannot work.
  if (!publicBrand(webEnv()).signUpOpen) redirect('/sign-in');
  return children;
}
