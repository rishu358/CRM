import { ImportPage } from '../../components/import-page';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ object?: string }>;
}) {
  const { object } = await searchParams;
  return <ImportPage initialObject={object ?? null} />;
}
