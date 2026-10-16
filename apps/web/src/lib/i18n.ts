/**
 * Translation layer (ADR-0011, CLAUDE.md §9).
 *
 * Every user-facing string goes through `t()` from day one, even though only
 * English ships. Retrofitting i18n means finding every literal in every
 * component, and the ones that are missed fail silently — a screen that is
 * mostly translated with three English words left in it.
 *
 * Deliberately tiny. It can be swapped for a full library later; what matters
 * now is that no component contains a literal string.
 */
const en = {
  'app.name': 'CRM',
  'nav.contacts': 'Contacts',
  'nav.accounts': 'Accounts',
  'nav.deals': 'Deals',
  'nav.settings': 'Settings',

  'contacts.title': 'Contacts',
  'contacts.new': 'New contact',
  'contacts.search': 'Search contacts',
  'contacts.searchPlaceholder': 'Name, email or phone',
  'contacts.empty.title': 'No contacts yet',
  'contacts.empty.description':
    'Contacts are the people you sell to. Add your first one, or import a list.',
  'contacts.empty.action': 'Add your first contact',
  'contacts.noResults.title': 'No contacts match that search',
  'contacts.noResults.description': 'Try a different name, email address or phone number.',
  'contacts.error.title': 'Could not load contacts',
  'contacts.error.description': 'Something went wrong. Try again in a moment.',
  'contacts.forbidden.title': 'You do not have access to contacts',
  'contacts.forbidden.description': 'Ask an administrator to grant you access.',
  'contacts.loadMore': 'Load more',
  'contacts.count': 'contacts loaded',

  'contact.firstName': 'First name',
  'contact.lastName': 'Last name',
  'contact.email': 'Email',
  'contact.phone': 'Phone',
  'contact.whatsapp': 'WhatsApp',
  'contact.title': 'Job title',
  'contact.leadSource': 'Lead source',
  'contact.owner': 'Owner',
  'contact.created': 'Created',
  'contact.updated': 'Last updated',
  'contact.notFound.title': 'Contact not found',
  'contact.notFound.description': 'It may have been deleted, or you may not have access to it.',
  'contact.details': 'Details',
  'contact.timeline': 'Timeline',
  'contact.backToList': 'Back to contacts',

  'field.empty': 'Not set',
  'field.hidden': 'Hidden',
  'field.save': 'Save',
  'field.cancel': 'Cancel',
  'field.edit': 'Edit',
  'field.saving': 'Saving',

  'conflict.title': 'Someone else saved first',
  'conflict.description':
    'This contact was changed while you were editing. Reload to see the latest version.',
  'conflict.reload': 'Reload',

  'error.generic': 'Something went wrong',
  'error.notWritable': 'You cannot edit this field',
  'error.required': 'This field is required',

  'auth.title': 'Sign in',
  'auth.description':
    'Paste a session token from `pnpm db:seed`. The credential sign-in flow arrives with the auth module.',
  'auth.token': 'Session token',
  'auth.submit': 'Continue',
  'auth.invalid': 'That token was not accepted.',
  'auth.signOut': 'Sign out',

  'common.loading': 'Loading',
  'common.retry': 'Try again',
} as const;

export type TranslationKey = keyof typeof en;

/** Look up a string. Interpolates `{name}` placeholders. */
export function t(key: TranslationKey, values?: Record<string, string | number>): string {
  const template: string = en[key];
  if (values === undefined) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
