import type { Metadata } from 'next';
import { EmailSettingsScreen } from '../../../components/email-settings-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('email.settings.title') };

/**
 * The company's email sender: name, reply address and footer (ADR-0073).
 */
export default function EmailSettingsPage() {
  return <EmailSettingsScreen />;
}
