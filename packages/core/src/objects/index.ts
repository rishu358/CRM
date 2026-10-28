/**
 * The object-type registry (ADR-0005).
 *
 * Polymorphic links store `(object_type, record_id)`, so `object_type` arrives
 * from the client on activities, tags, attachments and timeline queries. It is
 * therefore untrusted input that reaches a table name, and must be validated
 * against this closed set before it is used anywhere near SQL (CLAUDE.md §5.7).
 *
 * P2 adds custom objects. At that point this list gains a dynamic tail sourced
 * from tenant metadata; the validation boundary stays exactly here.
 *
 * It doubles as the registry `can()` reasons over, which is why administrative
 * objects such as `invitation`, `role`, `team` and `membership` appear here too
 * (MVP_SPEC M2, M3). They are not records: nothing links an activity or a tag to
 * an invitation, and none of them is a `BUSINESS_OBJECT_TYPE`, so they carry no
 * owner, no soft delete and no custom fields. When the polymorphic modules
 * arrive they validate against a narrower list of their own rather than widening
 * this one.
 *
 * `role`, `team` and `membership` are what the administration screens are
 * authorized against (MVP_SPEC M3), and `role:read` is also the gate on the
 * access explainer: anyone who may read the workspace's permission
 * configuration may ask what it does, and nobody else may — a sales rep must
 * not be able to enumerate colleagues or learn which fields are hidden from
 * them (ADR-0033).
 *
 * `audit_log`, `tenant_data` and `data_subject` are the same kind of thing for
 * MVP_SPEC M11. Reading the audit log, exporting the whole workspace and
 * acting on one person's data-protection rights are capabilities a role either
 * has or does not, and making them object types means they are granted as
 * **rows** like everything else — visible in the permission matrix, editable
 * without a deploy, and denied by the absence of a row. The alternative, an
 * `if (role === 'Owner')` somewhere in a service, is exactly what ADR-0008 and
 * CLAUDE.md §5.3 forbid.
 *
 * `pipeline` is the same kind of thing for the pipeline and stage editor
 * (MVP_SPEC M5, M9; ADR-0062). Reshaping the stages every deal moves through is
 * a company-wide configuration change, not an edit to a deal, so it is its own
 * grant: `deal:update` (a rep dragging a card) must never imply it. Seeing the
 * pipelines on the board stays `deal:read`; `pipeline:read` is the editor's view,
 * which also shows retired stages and how many deals sit in each.
 *
 * `lead_form` is the same kind of thing for the website lead form (ADR-0065): creating and editing a
 * form, rotating or revoking its key and switching it off are company-wide configuration, and the
 * form is a door onto the public internet, so it is an explicit grant that no record permission implies.
 *
 * They are kept apart rather than folded into one `data_rights` type because
 * the three differ in blast radius: a whole-workspace archive, one person's
 * file, and an irreversible erasure are not the same decision, and a single
 * type would make granting the mildest grant the most dangerous one.
 */

export const OBJECT_TYPES = [
  'account',
  'contact',
  'lead',
  'deal',
  'activity',
  'invitation',
  'role',
  'team',
  'membership',
  'audit_log',
  'tenant_data',
  'data_subject',
  'tenant_settings',
  'pipeline',
  'lead_form',
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

const OBJECT_TYPE_SET: ReadonlySet<string> = new Set(OBJECT_TYPES);

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === 'string' && OBJECT_TYPE_SET.has(value);
}

/** Validate untrusted input into an ObjectType, or throw. */
export function toObjectType(value: unknown): ObjectType {
  if (!isObjectType(value)) {
    throw new TypeError(`Unknown object type: ${String(value)}`);
  }
  return value;
}

/**
 * Object types an activity, tag or attachment may be attached to (ADR-0005).
 *
 * Narrower than `OBJECT_TYPES` on purpose, exactly as ADR-0005 anticipated:
 * `invitation` is administrative and nothing links to it, and an activity
 * linked to another activity is not a thing the product has. This is the
 * closed set a polymorphic `object_type` arriving from a client is validated
 * against before it is anywhere near SQL, and the set the `activity_links`
 * CHECK constraint repeats in the database.
 *
 * P2 custom objects widen this list; the validation boundary stays here.
 */
export const LINK_TARGET_TYPES = ['account', 'contact', 'lead', 'deal'] as const;
export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];

const LINK_TARGET_TYPE_SET: ReadonlySet<string> = new Set(LINK_TARGET_TYPES);

export function isLinkTargetType(value: unknown): value is LinkTargetType {
  return typeof value === 'string' && LINK_TARGET_TYPE_SET.has(value);
}

/**
 * Object types a file may be attached to (ADR-0005, ADR-0035).
 *
 * Wider than `LINK_TARGET_TYPES` by one: an activity can carry a file (the
 * recording of a call, the deck from a meeting), while nothing links an
 * activity to another activity, so the two closed sets genuinely differ and
 * neither is the other's superset by accident. Like every polymorphic set it
 * is the boundary an `object_type` from a client is validated against before
 * it is anywhere near SQL, and the `attachments` CHECK constraint repeats it.
 */
export const ATTACHMENT_TARGET_TYPES = ['account', 'contact', 'lead', 'deal', 'activity'] as const;
export type AttachmentTargetType = (typeof ATTACHMENT_TARGET_TYPES)[number];

const ATTACHMENT_TARGET_TYPE_SET: ReadonlySet<string> = new Set(ATTACHMENT_TARGET_TYPES);

export function isAttachmentTargetType(value: unknown): value is AttachmentTargetType {
  return typeof value === 'string' && ATTACHMENT_TARGET_TYPE_SET.has(value);
}

/** Object types that hold business records with owners and soft deletes. */
export const BUSINESS_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal'] as const;
export type BusinessObjectType = (typeof BUSINESS_OBJECT_TYPES)[number];

const BUSINESS_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(BUSINESS_OBJECT_TYPES);

export function isBusinessObjectType(value: unknown): value is BusinessObjectType {
  return typeof value === 'string' && BUSINESS_OBJECT_TYPE_SET.has(value);
}

/** The actions a role may be granted on an object type. */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'import'] as const;
export type Action = (typeof ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTION_SET.has(value);
}

/**
 * How much of an object type a grant covers.
 *
 * Ordered least to most permissive; `scopeRank` makes "at least this much"
 * comparisons explicit rather than relying on string ordering.
 */
export const SCOPES = ['own', 'team', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_RANK: Readonly<Record<Scope, number>> = { own: 0, team: 1, all: 2 };

export function scopeRank(scope: Scope): number {
  return SCOPE_RANK[scope];
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && value in SCOPE_RANK;
}

/** The widest of two scopes. Used when a user holds several roles. */
export function widestScope(a: Scope, b: Scope): Scope {
  return scopeRank(a) >= scopeRank(b) ? a : b;
}

/**
 * Object types that are capabilities rather than records (MVP_SPEC M2, M3, M11).
 *
 * Nothing is linked to them, none has an owner, and `own`/`team` scope would
 * deny everything on them — `all` is the only scope that means anything. Kept
 * as a list so a caller can say "this is not a record" without enumerating the
 * exceptions.
 *
 * `role`, `team` and `membership` belong here for the same reason as the rest:
 * they were added by M3 while this list was being added by M11, so a merge of
 * the two is the one moment the omission is invisible. A test below pins the
 * list to the complement of the record types, so the next type added to
 * `OBJECT_TYPES` has to be classified rather than quietly treated as a record.
 */
export const ADMINISTRATIVE_OBJECT_TYPES = [
  'invitation',
  'role',
  'team',
  'membership',
  'audit_log',
  'tenant_data',
  'data_subject',
  'tenant_settings',
  'pipeline',
  'lead_form',
] as const;
export type AdministrativeObjectType = (typeof ADMINISTRATIVE_OBJECT_TYPES)[number];

const ADMINISTRATIVE_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(ADMINISTRATIVE_OBJECT_TYPES);

export function isAdministrativeObjectType(value: unknown): value is AdministrativeObjectType {
  return typeof value === 'string' && ADMINISTRATIVE_OBJECT_TYPE_SET.has(value);
}

/**
 * Object types that soft-delete into the Recycle Bin (MVP_SPEC M4).
 *
 * The business objects plus `activity`: a task, call or meeting is a record
 * with an owner and a `deleted_at` like any other (ADR-0026), and somebody who
 * deletes the wrong meeting wants it back as much as somebody who deletes the
 * wrong contact.
 *
 * Identical today to `SEARCHABLE_OBJECT_TYPES`, and deliberately a separate
 * list: "can be found by typing a name" and "can be restored for thirty days"
 * are different properties that happen to hold of the same five things, and
 * collapsing them would silently decide the next object's answer to both.
 */
export const SOFT_DELETABLE_OBJECT_TYPES = [
  'account',
  'contact',
  'lead',
  'deal',
  'activity',
] as const;
export type SoftDeletableObjectType = (typeof SOFT_DELETABLE_OBJECT_TYPES)[number];

const SOFT_DELETABLE_SET: ReadonlySet<string> = new Set(SOFT_DELETABLE_OBJECT_TYPES);

export function isSoftDeletableObjectType(value: unknown): value is SoftDeletableObjectType {
  return typeof value === 'string' && SOFT_DELETABLE_SET.has(value);
}
