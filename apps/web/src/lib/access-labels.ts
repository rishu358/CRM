import type { TranslationKey } from './i18n';
import { t } from './i18n';

/**
 * The words for permissions (CLAUDE.md §9: every string through `t()`).
 *
 * Maps from the API's stable codes to translated text. The API sends codes —
 * `own`, `shared_team`, `narrowed` — never sentences, so a translator can
 * improve a phrase without it being an API change.
 */

const OBJECT_KEYS: Readonly<Record<string, TranslationKey>> = {
  account: 'access.object.account',
  contact: 'access.object.contact',
  lead: 'access.object.lead',
  deal: 'access.object.deal',
  activity: 'access.object.activity',
  invitation: 'access.object.invitation',
  role: 'access.object.role',
  team: 'access.object.team',
  membership: 'access.object.membership',
  audit_log: 'access.object.auditLog',
  tenant_data: 'access.object.tenantData',
  data_subject: 'access.object.dataSubject',
  tenant_settings: 'access.object.tenantSettings',
  pipeline: 'access.object.pipeline',
  lead_form: 'access.object.lead_form',
};

const OBJECT_SINGULAR_KEYS: Readonly<Record<string, TranslationKey>> = {
  account: 'access.objectOne.account',
  contact: 'access.objectOne.contact',
  lead: 'access.objectOne.lead',
  deal: 'access.objectOne.deal',
  activity: 'access.objectOne.activity',
};

const ACTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  read: 'access.action.read',
  create: 'access.action.create',
  update: 'access.action.update',
  delete: 'access.action.delete',
  export: 'access.action.export',
  import: 'access.action.import',
};

const VERB_KEYS: Readonly<Record<string, TranslationKey>> = {
  read: 'access.verb.read',
  create: 'access.verb.create',
  update: 'access.verb.update',
  delete: 'access.verb.delete',
  export: 'access.verb.export',
  import: 'access.verb.import',
};

const SCOPE_KEYS: Readonly<Record<string, TranslationKey>> = {
  own: 'access.scope.own',
  team: 'access.scope.team',
  all: 'access.scope.all',
};

const FIELD_ACCESS_KEYS: Readonly<Record<string, TranslationKey>> = {
  hidden: 'access.fieldAccess.hidden',
  read: 'access.fieldAccess.read',
  write: 'access.fieldAccess.write',
};

const DIRECTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  granted: 'access.direction.granted',
  revoked: 'access.direction.revoked',
  widened: 'access.direction.widened',
  narrowed: 'access.direction.narrowed',
};

/** Falls back to the code itself: an unknown value is shown, never hidden. */
function lookup(map: Readonly<Record<string, TranslationKey>>, code: string): string {
  const key = map[code];
  return key === undefined ? code : t(key);
}

export const objectLabel = (code: string): string => lookup(OBJECT_KEYS, code);
export const objectSingularLabel = (code: string): string => lookup(OBJECT_SINGULAR_KEYS, code);
export const actionLabel = (code: string): string => lookup(ACTION_KEYS, code);
/** The verb for a sentence: "can no longer *see* …". */
export const actionVerb = (code: string): string => lookup(VERB_KEYS, code);
export const fieldAccessLabel = (code: string): string => lookup(FIELD_ACCESS_KEYS, code);
export const directionLabel = (code: string): string => lookup(DIRECTION_KEYS, code);

/** `null` is "no grant at all" — shown as words, never as a blank. */
export function scopeLabel(code: string | null): string {
  return code === null ? t('access.scope.none') : lookup(SCOPE_KEYS, code);
}

/** The tone a direction of change should be drawn in. Losing reach is the careful one. */
export function directionTone(
  direction: string,
): 'destructive' | 'warning' | 'success' | 'primary' {
  switch (direction) {
    case 'revoked':
      return 'destructive';
    case 'narrowed':
      return 'warning';
    case 'granted':
      return 'primary';
    default:
      return 'success';
  }
}
