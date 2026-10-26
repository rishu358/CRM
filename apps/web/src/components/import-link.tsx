import { ImportIcon, buttonStyles } from '@crm/ui';
import Link from 'next/link';
import { t } from '../lib/i18n';

/**
 * "Import" beside "Export" on a list header: a link to the wizard with the
 * object already chosen. A link and not a button because it navigates, and
 * because it must work with a middle-click.
 *
 * It wears `buttonStyles` from the design system, so it is the outline button
 * to the eye and a link to everything else.
 */
export function ImportLink({ objectType }: { objectType: 'contact' | 'account' | 'lead' }) {
  return (
    <Link
      href={`/import?object=${objectType}`}
      className={buttonStyles({ variant: 'outline', size: 'md', className: 'gap-2' })}
    >
      <ImportIcon className="h-4 w-4" />
      {t('import.link')}
    </Link>
  );
}
