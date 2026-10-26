import { MyDayScreen } from '../../components/my-day';
import type { Metadata } from 'next';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('myDay.title') };

/**
 * The home screen: what this person has to do today (MVP_SPEC M6).
 */
export default function MyDayPage() {
  return <MyDayScreen />;
}
