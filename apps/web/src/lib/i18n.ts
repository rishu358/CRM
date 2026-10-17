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
  'auth.description': 'Welcome back. Sign in to your workspace.',
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.submit': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.forgot': 'Forgot your password?',
  'auth.noAccount': 'New here?',
  'auth.createAccount': 'Create an account',
  'auth.haveAccount': 'Already have an account?',
  'auth.google': 'Continue with Google',
  'auth.or': 'or',

  'auth.signUp.title': 'Create your account',
  'auth.signUp.description': 'Set up a workspace for your team. It takes a minute.',
  'auth.signUp.name': 'Your name',
  'auth.signUp.company': 'Company name',
  'auth.signUp.companyHint': 'Optional. You can change it later.',
  'auth.signUp.submit': 'Create account',
  'auth.signUp.sent.title': 'Check your email',
  'auth.signUp.sent.description':
    'If that address can be used, we have sent a link to confirm it. The link expires in 24 hours.',

  'auth.mfa.title': 'Two-factor authentication',
  'auth.mfa.description': 'Enter the six-digit code from your authenticator app.',
  'auth.mfa.code': 'Authentication code',
  'auth.mfa.submit': 'Verify',
  'auth.mfa.backupHint': 'Lost your phone? Enter one of your backup codes instead.',

  'auth.forgot.title': 'Reset your password',
  'auth.forgot.description':
    'Enter your email address and we will send you a link to choose a new password.',
  'auth.forgot.submit': 'Send reset link',
  'auth.forgot.sent.title': 'Check your email',
  'auth.forgot.sent.description':
    'If that address has an account, a reset link is on its way. It expires in one hour and can be used once.',
  'auth.forgot.back': 'Back to sign in',

  'auth.reset.title': 'Choose a new password',
  'auth.reset.description': 'Everyone signed in to this account will be signed out.',
  'auth.reset.password': 'New password',
  'auth.reset.confirm': 'Confirm new password',
  'auth.reset.submit': 'Set new password',
  'auth.reset.done.title': 'Password changed',
  'auth.reset.done.description': 'You can sign in with your new password now.',
  'auth.reset.mismatch': 'The two passwords do not match',
  'auth.reset.missingToken': 'This link is incomplete. Request a new one.',

  'auth.verify.pending': 'Confirming your email address',
  'auth.verify.done.title': 'Email confirmed',
  'auth.verify.done.description': 'Your address is confirmed. Sign in to get started.',
  'auth.verify.failed.title': 'This link did not work',
  'auth.verify.failed.description':
    'It may have expired or already been used. Request a new one from the sign-in screen.',

  'auth.error.invalidCredentials': 'Incorrect email address or password',
  'auth.error.notVerified': 'Confirm your email address before signing in',
  'auth.error.mfaInvalid': 'That code is not valid',
  'auth.error.throttled': 'Too many attempts. Wait a moment and try again.',
  'auth.error.generic': 'Something went wrong. Try again.',
  'auth.error.passwordPolicy':
    'Use at least 12 characters, mixing letters with numbers or symbols.',

  'security.title': 'Security',
  'security.description': 'Your password, two-factor authentication and signed-in devices.',
  'security.password.title': 'Password',
  'security.password.current': 'Current password',
  'security.password.new': 'New password',
  'security.password.submit': 'Change password',
  'security.password.done': 'Password changed. Other devices have been signed out.',

  'security.mfa.title': 'Two-factor authentication',
  'security.mfa.off': 'Not set up. Add a second factor to protect this account.',
  'security.mfa.on': 'On. Your authenticator app is required at sign-in.',
  'security.mfa.remaining': '{count} backup codes left',
  'security.mfa.enable': 'Set up two-factor authentication',
  'security.mfa.disable': 'Turn off',
  'security.mfa.scan':
    'Scan this with your authenticator app, or type the key in by hand, then enter the code it shows.',
  'security.mfa.secret': 'Setup key',
  'security.mfa.confirm': 'Confirm',
  'security.mfa.backupTitle': 'Save your backup codes',
  'security.mfa.backupDescription':
    'Each code works once, and they are shown only now. Keep them somewhere safe — they are how you get in if you lose your phone.',
  'security.mfa.disableTitle': 'Turn off two-factor authentication',
  'security.mfa.disableConfirm': 'Enter your password to confirm',

  'security.sessions.title': 'Where you are signed in',
  'security.sessions.current': 'This device',
  'security.sessions.lastSeen': 'Last used',
  'security.sessions.started': 'Signed in',
  'security.sessions.unknownDevice': 'Unknown device',
  'security.sessions.signOutOthers': 'Sign out other devices',
  'security.sessions.signedOut': 'Signed out of {count} other devices.',
  'security.sessions.onlyThis': 'This is the only device signed in.',

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
