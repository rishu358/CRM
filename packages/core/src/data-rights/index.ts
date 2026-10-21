/**
 * DPDP / GDPR data rights, and the Recycle Bin's retention rule
 * (MVP_SPEC M4, M11).
 *
 * Pure policy: what counts as personal data on each object, what an erased
 * value looks like, and how long a soft-deleted record stays restorable. The
 * API, the worker and the tests all read these from here, so "30 days" and
 * "[erased]" exist once rather than in four places that can drift.
 */

/**
 * How long a soft-deleted record can be restored (MVP_SPEC M4).
 *
 * After this the purge job removes it for good. Expressed in days because that
 * is how the product describes it to the user; the job compares against
 * `deleted_at` using the database's clock, never this process's.
 */
export const RECYCLE_BIN_RETENTION_DAYS = 30;

/** How many records one purge pass removes before re-arming. Keeps locks short. */
export const PURGE_BATCH_SIZE = 200;

/** How often the purge sweep runs for a tenant, once armed. */
export const PURGE_SWEEP_INTERVAL_HOURS = 24;

/**
 * What an erased value reads as, in the record and in the audit diff.
 *
 * MVP_SPEC M11 names this literal: "audit diffs redacted (audit row kept,
 * personal values replaced with `[erased]`)". It is deliberately not an empty
 * string or a null — the point of keeping the row is that a reader can see a
 * value *was* there and has been erased on request, which an empty field would
 * not say.
 */
export const ERASED_PLACEHOLDER = '[erased]';

/** The objects a data-subject request can be made about. */
export const ERASABLE_OBJECT_TYPES = ['contact', 'lead'] as const;
export type ErasableObjectType = (typeof ERASABLE_OBJECT_TYPES)[number];

const ERASABLE_SET: ReadonlySet<string> = new Set(ERASABLE_OBJECT_TYPES);

export function isErasableObjectType(value: unknown): value is ErasableObjectType {
  return typeof value === 'string' && ERASABLE_SET.has(value);
}

/**
 * How one column is dealt with when the person behind the record is erased.
 *
 *   - `clear`    the value is deleted outright (null).
 *   - `redact`   the value is replaced by `[erased]`, because the column is
 *                `NOT NULL` or because a record with no name at all is an
 *                unreadable hole in every list and timeline the person appears
 *                in. Pseudonymisation rather than deletion, which is what both
 *                DPDP §12 and GDPR Art. 17 accept where a record must remain
 *                for an independent reason — here, that the deal it is attached
 *                to is the company's own commercial record.
 *   - `empty`    a jsonb column is replaced by `{}`.
 */
export type ErasureTreatment = 'clear' | 'redact' | 'empty';

/**
 * The personal columns of each erasable object, and what happens to each.
 *
 * Deliberately a table rather than a heuristic. "Which columns are personal" is
 * a legal judgement about this schema, and a rule like "anything that looks like
 * an email" would silently miss `whatsapp` the day somebody adds it. A new
 * column that holds personal data has to be added here, and the erasure test
 * asserts the shape of what is left so an omission shows up as a failure rather
 * than as residual data.
 *
 * Keys are snake_case column names: these are used to build SQL and to decide
 * which audit-diff entries to redact, and the audit side converts to match.
 */
export const PII_COLUMNS: Readonly<
  Record<ErasableObjectType, Readonly<Record<string, ErasureTreatment>>>
> = {
  contact: {
    first_name: 'clear',
    last_name: 'redact',
    email: 'clear',
    phone: 'clear',
    whatsapp: 'clear',
    title: 'clear',
    address: 'empty',
    consent: 'empty',
  },
  lead: {
    first_name: 'clear',
    last_name: 'redact',
    email: 'clear',
    phone: 'clear',
    company: 'clear',
  },
};

/** The personal field keys of an object, for the audit redaction. */
export function piiFieldKeys(objectType: ErasableObjectType): readonly string[] {
  return Object.keys(PII_COLUMNS[objectType]);
}

/**
 * Custom fields hold whatever the tenant put in them, and we cannot know which
 * of those are personal. Erasure empties the whole `custom_fields` object for
 * the subject rather than guessing — the safe direction, and the one a data
 * subject asked for.
 */
export const ERASE_CUSTOM_FIELDS = true;

export type ErasureStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** Archive kinds a data-rights export can produce (MVP_SPEC M11). */
export const DATA_EXPORT_KINDS = ['audit_log', 'tenant', 'data_subject'] as const;
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

const DATA_EXPORT_KIND_SET: ReadonlySet<string> = new Set(DATA_EXPORT_KINDS);

export function isDataExportKind(value: unknown): value is DataExportKind {
  return typeof value === 'string' && DATA_EXPORT_KIND_SET.has(value);
}

/**
 * Which capability each archive kind is granted through.
 *
 * One place, so the API, the worker and the route documentation cannot disagree
 * about who may ask for which file. The worker re-checks this when it runs, so
 * a capability revoked between the request and the run means no file.
 */
export const DATA_EXPORT_CAPABILITY: Readonly<
  Record<DataExportKind, { readonly objectType: 'audit_log' | 'tenant_data' | 'data_subject' }>
> = {
  audit_log: { objectType: 'audit_log' },
  tenant: { objectType: 'tenant_data' },
  data_subject: { objectType: 'data_subject' },
};
