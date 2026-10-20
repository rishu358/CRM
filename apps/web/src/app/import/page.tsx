import { ImportPage } from '../../components/import-page';
import type { Metadata } from 'next';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('import.title') };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ object?: string }>;
}) {
  const { object } = await searchParams;
  return <ImportPage initialObject={object ?? null} />;
}
