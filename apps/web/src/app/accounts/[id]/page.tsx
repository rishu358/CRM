import { AccountDetail } from '../../../components/account-detail';
import type { Metadata } from 'next';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('accounts.title') };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountDetail id={id} />;
}
