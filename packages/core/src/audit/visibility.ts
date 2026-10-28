import { isBusinessObjectType, type ObjectType } from '../objects/index.js';
import { canReadField } from '../permissions/field-access.js';
import type { Actor } from '../permissions/types.js';

/**
 * Field-level permissions over an audit diff (MVP_SPEC M3, CLAUDE.md §5.4).
 *
 * MVP_SPEC M3's acceptance criterion is that a field hidden from a role never
 * appears "in API responses, exports, search results **or audit diffs** shown
 * to that role". The audit log is the one read path where that is easy to get
 * wrong, because a diff is not a record: it is a `jsonb` blob whose keys are
 * field names and whose values are the *old and new values of those fields*. An
 * administrator who cannot read `email` but can read history would otherwise
 * learn every address the contact has ever had — strictly more than reading the
 * field would have told them.
 *
 * So the diff is filtered here, by the same `canReadField` every serializer
 * calls, and this function is the only way the `changes` column reaches a
 * response or an export file. It is pure and lives in `@crm/core` for the same
 * reason `diffChanges` does: the API serves the viewer and the worker writes the
 * archive, and two implementations of "what may this person see" is how the two
 * end up disagreeing.
 *
 * Three rules, each with a test:
 *
 *   1. a top-level key is kept only if the actor may read the field it names;
 *   2. `customFields` — which `diffChanges` records as one blob holding every
 *      custom value — is split per key and each key checked on its own, so a
 *      hidden custom field cannot ride along inside a visible entry;
 *   3. a row about an object type the actor cannot read at all yields nothing,
 *      which keeps the viewer from becoming a way around record permissions as
 *      well as field ones.
 */

export type AuditChangeSet = Readonly<Record<string, { old?: unknown; new?: unknown }>>;

/**
 * `lastName` -> `last_name`.
 *
 * `diffChanges` is handed database rows, so its keys are the camelCase ones
 * Drizzle produces, while `field_definitions`, `field_permissions` and every
 * `canReadField` call use the snake_case column name. Converting rather than
 * keeping a per-module mapping table is deliberate: a mapping with a missing
 * entry fails **open** — no field is named, so nothing is checked and the value
 * is shown. A conversion cannot have a missing entry.
 */
export function toFieldKey(apiKey: string): string {
  return apiKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Keys that describe the event rather than a field of the record.
 *
 * `version` and the bookkeeping columns are already excluded by `diffChanges`.
 * What is left is the handful of keys services write into a diff deliberately to
 * say what kind of change it was — an export's row count and format, the
 * import job a record came from, the reason given for an erasure. They are
 * metadata about the event, not data about the person, and no
 * `field_definitions` row describes them.
 */
/**
 * They are matched **before** the field check, so a key here is shown to anybody
 * who may read the row. That is only safe while no object actually has a field
 * of that name, which is a property of the schema rather than of this file — so
 * `visibility.spec.ts` asserts the two sets do not intersect, against the
 * standard columns of every object. A new field called `reason` would fail that
 * test rather than quietly leak.
 */
const EVENT_METADATA_KEYS: ReadonlySet<string> = new Set([
  'completed',
  'download',
  'rowCount',
  'format',
  'filter',
  'sort',
  'q',
  'importJobId',
  'reason',
  'restoredFrom',
  'retentionDays',
  'auditRowsRedacted',
  'recordsErased',
  // A merge (ADR-0064): what the record was folded into or received, and how much moved.
  'mergedInto',
  'mergedFrom',
  'moved',
]);

/**
 * May this actor see audit rows about this object type at all?
 *
 * For a business object the answer is their `read` grant on it: history about a
 * deal is information about that deal. For a platform object type — an
 * invitation, a session, an export job, the tenant itself — there is no record
 * to hold a grant on, and the `audit_log` grant the caller already needed in
 * order to reach the viewer is the whole answer.
 *
 * Record **scope** is deliberately not applied here; see `AuditLogService` for
 * why the viewer requires `all` scope rather than pretending `own` means
 * something on a log.
 */
export function canViewAuditObjectType(actor: Actor, objectType: string): boolean {
  if (!isBusinessObjectType(objectType)) return true;
  return actor.permissions.roles.some((role) => role.grants.has(`${objectType}:read`));
}

export interface VisibleAuditChanges {
  readonly changes: AuditChangeSet;
  /** How many entries were removed, so the viewer can say so honestly. */
  readonly withheldFields: number;
}

/**
 * The part of a diff this actor may see.
 *
 * An empty result is returned rather than the row being dropped: *that* a
 * change happened is not itself sensitive, and hiding the row would make the
 * audit log quietly incomplete for that reader — the worst failure mode an
 * audit log has. The viewer shows the row with an empty diff and a count of
 * what was withheld.
 */
export function visibleAuditChanges(
  actor: Actor,
  objectType: string,
  changes: AuditChangeSet | null | undefined,
): VisibleAuditChanges {
  if (changes === null || changes === undefined) {
    return { changes: {}, withheldFields: 0 };
  }
  if (!canViewAuditObjectType(actor, objectType)) {
    return { changes: {}, withheldFields: Object.keys(changes).length };
  }
  // Nothing in a platform object's diff is field-permission controlled, because
  // no `field_definitions` row describes it.
  if (!isBusinessObjectType(objectType)) {
    return { changes, withheldFields: 0 };
  }

  const object = objectType as ObjectType;
  const visible: Record<string, { old?: unknown; new?: unknown }> = {};
  let withheld = 0;

  for (const [key, value] of Object.entries(changes)) {
    if (EVENT_METADATA_KEYS.has(key)) {
      visible[key] = value;
      continue;
    }

    if (key === 'customFields') {
      const split = splitCustomFields(actor, object, value);
      Object.assign(visible, split.entries);
      withheld += split.hidden;
      continue;
    }

    if (canReadField(actor, object, toFieldKey(key))) {
      visible[key] = value;
    } else {
      withheld += 1;
    }
  }

  return { changes: visible, withheldFields: withheld };
}

/**
 * One `customFields` entry becomes one entry per custom field that changed.
 *
 * `diffChanges` compares the whole `custom_fields` jsonb, so a change to any one
 * custom value is recorded as a single `customFields: { old: {…}, new: {…} }`
 * entry containing **every** custom value the record has. Filtering that entry
 * as a unit would be all-or-nothing, and keeping it would hand over every hidden
 * custom field at once.
 *
 * Splitting also makes the viewer better: `customFields.gst_status` reads like
 * the field it is, rather than as two JSON blobs the reader has to diff by eye.
 */
function splitCustomFields(
  actor: Actor,
  objectType: ObjectType,
  value: { old?: unknown; new?: unknown },
): { readonly entries: Record<string, { old?: unknown; new?: unknown }>; readonly hidden: number } {
  const before = asRecord(value.old);
  const after = asRecord(value.new);
  const entries: Record<string, { old?: unknown; new?: unknown }> = {};
  let hidden = 0;

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = before[key] ?? null;
    const newValue = after[key] ?? null;
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    // A custom field key *is* the `field_definitions` key, so no conversion:
    // `toFieldKey` here would mangle a key the tenant chose.
    if (!canReadField(actor, objectType, key)) {
      hidden += 1;
      continue;
    }
    entries[`customFields.${key}`] = { old: oldValue, new: newValue };
  }

  return { entries, hidden };
}

/** Exported for the collision test described above; not part of the API. */
export const EVENT_METADATA_KEY_LIST: readonly string[] = [...EVENT_METADATA_KEYS];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
