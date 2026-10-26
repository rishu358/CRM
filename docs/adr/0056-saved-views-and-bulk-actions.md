# ADR-0056: Saved views and bulk actions

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

MVP_SPEC M4 lists, for the Account, Contact, Lead and Deal lists, "saved views, bulk edit/assign/delete/tag"
and M3 lists "ownership and reassignment (single and bulk)". Reassignment was built (ADR-0033's access
module). Saved views and the other three bulk actions were not: the `saved_views` table existed with
row-level security and nothing used it, there was no bulk endpoint, `tags` and `record_tags` had no API
at all, and the lists had no filter or sort controls for a view to remember.

Both features have the same danger. A saved view is **somebody's query, shown to somebody else**; a bulk
action is **one request that changes up to hundreds of records**. Either can quietly become a way to see
or change what a person could not through the ordinary screens: a shared view that filters on a field
the reader may not see, a bulk delete that names ids from another workspace, a response that says
"forbidden" for one id and "not found" for another and so tells the caller which ids exist.

## Decision

### Saved views

- **A view stores the state of a list and nothing else:** the search text, a list of
  `{ field, operator, value }` conditions, column keys and at most one sort. Never SQL, never record ids.
  Applying a view is the client putting those into the **ordinary list request**, which validates them
  again against the reader's permissions. A view therefore has no data path of its own and cannot widen
  what anybody reads. The shape is in `filters jsonb` as `{ q?, conditions[] }`, `columns` as field keys
  and `sort` as `[{ field, direction }]` (migration 0023 did not change the column types).
- **Fields in a view are held to what the list holds them to,** by the same `planQuery` an export uses:
  real standard column or **active** custom field, readable by the caller, value well formed. A field the
  caller cannot read is "Unknown field", exactly as one that does not exist. This holds on create and on
  every edit, judged against what is being saved.
- **A shared view that uses a field the reader cannot read is listed, flagged `applicable: false`, and
  returned without its filter, sort or that column.** Showing the condition would name the hidden field
  and its value. The view is somebody's work, so it is not hidden; it is not offered for use either.
- **Visibility is `private`, `team` or `tenant`, enforced twice.** The service: `private` always; `team`
  needs the author to be on a team; `tenant` needs `update` on `tenant_settings` (the grant that renames
  the company), so sharing with everyone is a row in the permission matrix and not a role name
  (CLAUDE.md §5.3). The database: three **restrictive** policies on `saved_views` (migration 0023) narrow
  every read to private-and-mine, team-shared-with-me and tenant-wide, and every write to the creator.
  A restrictive policy is ANDed with the tenant policy, so it can only narrow; a mistake in it cannot
  open anything across tenants. "Team" means the viewer shares at least one team with the author; a
  record or view has no team column, as with `team` scope on records.
- **Only the creator edits or deletes.** A colleague who can see a shared view and tries gets 403 (they
  know it exists); one who cannot see it gets 404. Edits and deletes carry `version` (409 on a stale
  one, CLAUDE.md §7), which is why `saved_views` gained a `version` column.
- **Reading a view needs `read` on its object type.** There is no new object type in the permission
  catalogue: a view of deals describes the deals list, so whoever cannot open it cannot list its views.
  Adding `saved_view` as a catalogue entry would have needed a grant backfill for every existing role,
  for no rule that `read` on the object does not already state.
- A view is hard-deleted: it is configuration, not a business record, and has no Recycle Bin.

### Bulk actions

- **One endpoint, `POST /api/v1/bulk-actions`,** with a closed union of actions (`edit`, `assign`,
  `delete`, `tag_add`, `tag_remove`) and a closed union of targets: up to **200 ids**, or a **filter**
  (the list's search and conditions) which the server resolves for the caller, in id order, 200 at a
  time, handing back `nextCursor` until nothing is left. The cap holds for both. The web app loops.
- **One transaction per call, one savepoint per record.** A record that cannot be changed is skipped
  and reported and the others go through: documented **partial success**, because failing two hundred
  records for one conflicted row would make the feature unusable on a busy list. An unexpected failure
  (a database error, a bug) is not a skip; it rolls back the whole call so nothing is half-written.
- **A bulk action cannot do what a single one cannot, because it uses the same code.** Each record goes
  through `updateInTx` / `removeInTx` on the owning module's own service (extracted from `update` and
  `remove`, the way `createInTx` was extracted for lead conversion), so `can()` with the record's owner
  and teams, field-level write permission, the version guard, the audit entry and the outbox event are
  not copied. Assign goes through the ownership service (`reassignInTx`), so only `all` scope may hand a
  record to somebody else and the new owner must be able to see it. Tags need `update` on the record,
  asked of the owning module. Modules still do not touch each other's tables (CLAUDE.md §3).
- **Optimistic locking still holds.** The version each record had when the call began is the version
  its update expects. A record somebody saved in the meantime is skipped as `version_conflict`, never
  overwritten.
- **Bulk edit changes a short allowlist of system fields plus active custom fields.** Names, email,
  phone, GSTIN, domain (an identifier a person has one of), the owner (that is `assign`), a deal's
  amount and pipeline, and `status = converted` are not on it. It is an allowlist because "everything
  except" fails open when the next column is added. The value is checked once, against the object's own
  update schema, before any record is touched, so a wrong value is a 422 for the whole request.
- **The report never tells a caller which ids exist.** `not_found` is one answer for an id that is
  missing, deleted, in another tenant or outside the caller's scope. `not_permitted` is said only of a
  record the caller can already see. `no_change` and `version_conflict` likewise concern records they
  can see. A filter target only ever matches what the caller may change.
- **A hidden field is unusable in bulk too.** Editing one is `FIELD_NOT_WRITABLE`, the same answer as
  for a field that does not exist; a filter on one is "Unknown field".
- **Retries:** an `Idempotency-Key` stores the result in `bulk_operations` in the same transaction as
  the changes, per person and per tenant, and a retry with the same key and request returns it with
  `replayed: true`; the same key for a different request is 409. A per-key advisory lock makes two
  simultaneous retries run once. Stored answers are swept after 24 hours. A `dryRun` runs everything
  and rolls back; it is never stored.
- **Audit and events are per record, in the transaction.** Rows from one call share the request id.
  There is no extra summary row; the request id is the grouping.
- **Rate limits** are the existing per-user and per-tenant counters: one bulk request is one request.
  The cost of a request is bounded by the cap instead of by a weighted counter.
- **Tags** are created the first time a bulk action names one (case-insensitive: "VIP" and "vip" are
  one tag), up to 500 per workspace, and are listed at `GET /api/v1/tags`.

## Consequences

- Four merged services each gained two methods whose bodies were moved, not rewritten; their existing
  specs still pass and now cover the shared path.
- A person without the grant for an action sees the API's refusal in words rather than a hidden button.
  The UI does not know who may do what; hiding would be cosmetic anyway (CLAUDE.md §9).
- **Not built, on purpose, and recorded so nobody assumes otherwise:** showing tags on a record or in a
  list, and filtering a list by tag (tags can be added, removed and listed); bulk edit of a reference
  field from the UI (the API accepts a contact's account and an account's parent, the dialog has no
  record picker); filtering by money columns in the builder (they are stored in minor units, so a typed
  figure would be 100 times too small until the builder converts); built-in column choice on the
  Contacts, Leads and Deals lists (only Accounts has a built-in column chooser, so a view's columns
  there are the custom ones); and the view's `team` meaning "shares a team", not "one named team".
- A view whose author later loses the grant to read a field stays stored as written; each reader
  is judged on their own, so it is not wrong, only unavailable to those who cannot read the field.
- Bulk action rows in `bulk_operations` are the only new table. It carries `tenant_id` with row-level
  security, plus a policy that shows a person only their own keys.
