import { LeadsPage } from '../../components/leads-page';
import type { Metadata } from 'next';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('leads.title') };

export default function Page() {
  return <LeadsPage />;
}
