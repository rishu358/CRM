import Link from 'next/link';
import { t } from '../lib/i18n';

/**
 * "Import" beside "Export" on a list header: a link to the wizard with the
 * object already chosen. A link and not a button because it navigates, and
 * because it must work with a middle-click.
 *
 * It looks like the outline `Button`; it is a different element for a
 * different reason, which is the one case the design system's `Button` does not
 * cover (it renders a `<button>`).
 */
export function ImportLink({ objectType }: { objectType: 'contact' | 'account' | 'lead' }) {
  return (
    <Link
      href={`/import?object=${objectType}`}
      className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {t('import.link')}
    </Link>
  );
}
