import type { Metadata } from 'next';
import { TagsScreen } from '../../../components/tags-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('tags.title') };

/**
 * The workspace's tags: rename, recolour, delete (ADR-0063).
 */
export default function TagsPage() {
  return <TagsScreen />;
}
