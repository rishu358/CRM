/**
 * Audit diffs (CLAUDE.md §5.10).
 *
 * Pure, so it lives in core: the API writes an audit entry for every change a
 * request makes, and the worker writes the same entry for every record an
 * import creates or updates. One definition of "what changed" means the audit
 * log reads the same whichever process wrote the row.
 */

/**
 * Build a diff of only what changed.
 *
 * Comparing by JSON rather than identity so that two equal objects or dates do
 * not register as a change and fill the audit log with noise.
 */
/**
 * Bookkeeping columns, excluded from diffs.
 *
 * They change on every write by definition, so including them buries the one
 * field the user actually edited and makes "updated: updatedBy, title" the
 * normal shape of a timeline entry. The actor and the time are recorded on the
 * audit row itself, so nothing is lost by leaving them out here.
 */
const INTERNAL_COLUMNS = new Set(['createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'version']);

/**
 * JSON, with a decision about `bigint`.
 *
 * `JSON.stringify` throws on a BigInt rather than rendering it, so a single
 * bigint column anywhere in a record turns every audit entry for that object
 * into an unhandled 500 — including the one for a change that had nothing to
 * do with it. Money is stored as minor units in a bigint (CLAUDE.md §7), so
 * this is not a corner case; it is the first object with an amount on it.
 *
 * Rendered as a **decimal string**, for the reason the API does the same on
 * the wire: a number past 2^53 would be rounded, and an audit log that
 * disagrees with the record by a rupee is worse than no audit log, because it
 * will be believed.
 */
function toJsonValue(value: unknown): unknown {
  return JSON.parse(stableJson(value)) as unknown;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner) =>
    typeof inner === 'bigint' ? inner.toString() : (inner as unknown),
  );
}

export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { old?: unknown; new?: unknown }> {
  const changes: Record<string, { old?: unknown; new?: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (INTERNAL_COLUMNS.has(key)) continue;
    const oldValue = before[key];
    const newValue = after[key];
    if (stableJson(oldValue) !== stableJson(newValue)) {
      changes[key] = { old: toJsonValue(oldValue), new: toJsonValue(newValue) };
    }
  }
  return changes;
}
