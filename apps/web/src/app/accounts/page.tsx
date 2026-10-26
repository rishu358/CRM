import { AccountsPage } from '../../components/accounts-page';
import type { Metadata } from 'next';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('accounts.title') };

export default function Page() {
  return <AccountsPage />;
}
