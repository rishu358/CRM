import type { Metadata } from 'next';
import { LeadAssignmentScreen } from '../../../components/lead-assignment-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('assignment.title') };

/**
 * The rules that choose who gets a new lead, for administrators (ADR-0065 10).
 */
export default function LeadAssignmentPage() {
  return <LeadAssignmentScreen />;
}
