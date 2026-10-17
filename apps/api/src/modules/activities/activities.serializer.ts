import {
  canReadField,
  canWriteField,
  FieldNotWritableError,
  type Actor,
  type FieldDefinition,
} from '@crm/core';
import { sanitizeRichText } from '@crm/core/html';
import type { Activity as ActivityRow } from '@crm/db';
import type { ActivityLinkView } from '@crm/contracts';

/**
 * Field-level permissions, applied at the boundary (CLAUDE.md §5.4).
 *
 * This is the last thing between the database and the response body, and
 * every read path has to come through it. The activities version adds one
 * thing the other modules do not have: the body is **sanitized again on the
 * way out** (ADR-0024). Sanitizing on write already means nothing dangerous
 * is stored, but a row can arrive from an import, a restored backup or a
 * future code path, and this is the last point before it is rendered as HTML
 * in somebody's browser.
 *
 * `field_definitions` keys are snake_case, matching the column. The API
 * speaks camelCase. The mapping lives here so a permission check is never
 * accidentally made against the wrong name — which would silently pass.
 */
const STANDARD_FIELD_KEYS: Readonly<Record<string, string>> = {
  type: 'type',
  subject: 'subject',
  body: 'body',
  dueAt: 'due_at',
  completedAt: 'completed_at',
  priority: 'priority',
  status: 'status',
  assignedTo: 'assigned_to',
};

/**
 * Write-only inputs that are not columns.
 *
 * `reminderMinutesBefore` says when to remind about the due date, so it is
 * governed by permission on `due_at` rather than on a field of its own: a
 * caller who may not set the due date has no business moving its reminder.
 */
const DERIVED_WRITE_KEYS: Readonly<Record<string, string>> = {
  reminderMinutesBefore: 'due_at',
};

/** Always visible: identity and concurrency metadata, not business data. */
const ALWAYS_VISIBLE = ['id', 'version', 'createdAt', 'updatedAt'] as const;

export interface SerializedActivity {
  readonly [key: string]: unknown;
}

/**
 * Build the response body for one activity.
 *
 * A field the actor may not read is **omitted**, not nulled: a null would
 * still confirm the field exists and that this record has a value for it.
 *
 * `links` carries only the targets the caller may read. The resolution
 * happens in the service, which asks each record module whether this actor
 * can see the record; a link to a contact outside their scope never reaches
 * here, so an activity is not a way around record scope (ADR-0005).
 */
export function serializeActivity(
  actor: Actor,
  row: ActivityRow,
  fields: readonly FieldDefinition[],
  links: readonly ActivityLinkView[],
): SerializedActivity {
  const result: Record<string, unknown> = {};

  for (const key of ALWAYS_VISIBLE) {
    result[key] = key === 'createdAt' || key === 'updatedAt' ? row[key].toISOString() : row[key];
  }

  for (const [apiKey, fieldKey] of Object.entries(STANDARD_FIELD_KEYS)) {
    if (!canReadField(actor, 'activity', fieldKey)) continue;
    result[apiKey] = readValue(row, apiKey);
  }

  const customFields: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isSystem || !field.isActive) continue;
    if (!canReadField(actor, 'activity', field.key)) continue;
    customFields[field.key] = row.customFields[field.key] ?? null;
  }
  result['customFields'] = customFields;
  result['links'] = links;

  return result;
}

function readValue(row: ActivityRow, apiKey: string): unknown {
  switch (apiKey) {
    case 'dueAt':
      return row.dueAt?.toISOString() ?? null;
    case 'completedAt':
      return row.completedAt?.toISOString() ?? null;
    case 'body':
      // Sanitized on the way out as well as on the way in (ADR-0024).
      return sanitizeRichText(row.body);
    default:
      return (row as unknown as Record<string, unknown>)[apiKey] ?? null;
  }
}

export function serializeActivities(
  actor: Actor,
  rows: readonly ActivityRow[],
  fields: readonly FieldDefinition[],
  linksByActivity: ReadonlyMap<string, readonly ActivityLinkView[]>,
): SerializedActivity[] {
  return rows.map((row) =>
    serializeActivity(actor, row, fields, linksByActivity.get(row.id) ?? []),
  );
}

/**
 * Reject a write that touches a field the actor may not write.
 *
 * Rejected, never silently dropped: dropping tells the user their edit saved
 * when it did not, and hides a genuine permission misconfiguration from
 * whoever set it up. Hidden and read-only fields are reported identically so
 * the error cannot be used to discover which fields exist but are concealed.
 */
export function assertWritableActivityFields(
  actor: Actor,
  payload: Record<string, unknown>,
  fields: readonly FieldDefinition[],
): void {
  const rejected: string[] = [];

  for (const apiKey of Object.keys(payload)) {
    if (apiKey === 'customFields' || apiKey === 'version' || apiKey === 'links') continue;
    const fieldKey = STANDARD_FIELD_KEYS[apiKey] ?? DERIVED_WRITE_KEYS[apiKey];
    if (fieldKey === undefined) continue;
    if (!canWriteField(actor, 'activity', fieldKey)) rejected.push(apiKey);
  }

  const custom = payload['customFields'];
  if (custom !== undefined && custom !== null && typeof custom === 'object') {
    for (const key of Object.keys(custom)) {
      const definition = fields.find((field) => field.key === key);
      if (definition === undefined || !definition.isActive) {
        // Unknown or deactivated: reported the same way, so probing for the
        // existence of a concealed field learns nothing.
        rejected.push(key);
        continue;
      }
      if (!canWriteField(actor, 'activity', key)) rejected.push(key);
    }
  }

  if (rejected.length > 0) throw new FieldNotWritableError(rejected);
}

export { STANDARD_FIELD_KEYS };
