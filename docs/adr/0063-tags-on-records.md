# ADR-0063: Tags on records: where they show, how a list filters by them, who manages them

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

PR 10 (ADR-0056) built the tag tables' API: a tag is created the first time a bulk action names it, up to 500
per workspace, and bulk `tag_add` / `tag_remove` attach and detach it. It deliberately stopped there. A tag
could be added to a record and nothing showed it, a list could not be filtered by it, and a tag could not be
renamed or deleted. MVP_SPEC M4 lists tags on the record page, and every Zoho paid plan shows them
(docs/research/zoho-gap-analysis.md).

Facts that shape the design, read from the code:

- `record_tags (tag_id, object_type, record_id)` is polymorphic (ADR-0005) and unique per tag and record. `tags`
  has `name` (unique per workspace, case-sensitively in the index, case-insensitively in the code) and `color`
  (never used), and no `version`.
- A filter is written in six places: each of the four object modules' `sql-helpers`, `planQuery` in `@crm/db`
  (used by exports, saved views and bulk-by-filter), and `QUERY_COLUMNS` in core. Saved views and the export
  validate a filter's field against the same lists.
- `canReadField` judges a key by the actor's grant on the object plus any `field_permissions` row for that key.
  A tag is not a field and no row can name it.

## Decision

1. **Adding and removing a tag on one record is the bulk action with one id.** The record page calls
   `POST /bulk-actions` with `tag_add` or `tag_remove` and one id. It gets the permission check (`update` on that
   record, at the actor's scope), the 500-tag cap, the audit entry, the outbox event and the `Idempotency-Key`
   with no second write path to keep in step. Tags are a **relation**, not a field of the record, so tagging does
   not move the record's `version` (as in PR 10). An edit of the record's fields never carries tags, so there is
   no version to lock on a tag; the settings screen's edits of a tag itself do (point 4).

2. **Tags ride on every read of a record.** The contact, account, lead and deal detail responses and each row of
   their lists carry `tags: [{ id, name, color }]`, by name ignoring case. They are added **after** the
   field-permission serializer, because a tag is not a field. One query per page, never per row
   (`TagsService.attach`, over `tagsForRecords` in `@crm/db`), handed only ids the service already loaded under
   the reader's record scope, so a tag is never reported for a record the reader cannot see. The create response
   does not carry them (a new record has none).

3. **A list is filtered by tag through the existing filter builder.** `tags` is a pseudo-field, not a column and
   not a field definition, with two new operators, `has_any` and `has_none`, whose value is up to six tag ids
   (six, because a view condition's value is at most 256 characters). One shared statement in `@crm/db`
   (`tagFilterSql`: an `exists` over `record_tags` correlated to the row's id and tenant, ids validated as uuids
   and bound as parameters) is called from all six filter builders, so a list, an export, a saved view and a
   bulk-by-filter agree. The tag operators are valid on `tags` only and `tags` takes no other operator (422
   either way); `tags` is never sortable. It is also not in `QUERY_COLUMNS`, which stays "columns", so the
   export/list parity test's key sets are unchanged. A tag id that names nothing matches no record (so
   `has_none` of it is every record); whether an id is real is not revealed. A saved view stores tag **ids**:
   if the tag is later deleted the view finds nothing, which is stated rather than silently dropped.

4. **Managing tags needs `update` on `tenant_settings`**, the grant that already guards sharing a view with
   everyone (ADR-0056). It is a row in the permission matrix, not a role name (CLAUDE.md §5.3), and it needed no new
   catalogue entry and so no backfill of every existing role. Rename, recolour and delete carry the tag's
   `version` (migration 0025 adds it): a stale one is a 409. A name another tag already has, ignoring case, is a
   409; migration 0025 also makes `lower(name)` unique per workspace, so the rule is the database's as well. The
   colour is one of eight **names** (`TAG_COLORS`), checked by Zod and by a `CHECK`, never free text, because
   the value is stored and sent to every browser and a name cannot carry CSS. The chip draws a dot in the
   colour on the page's own `secondary` surface, so no colour a person picks can put unreadable text on the
   screen (contrast is tested for that pair in both themes).

5. **Deleting a tag writes one audit entry and one event for the tag**, with how many live records it was on, and
   not one per record. The foreign key cascades the `record_tags` rows. A tag on a hundred thousand records would
   otherwise be a hundred thousand audit rows and events in one request. The settings screen shows the count per
   kind before the delete and asks for a confirmation. Usage counts are for people who manage tags only (they
   count every record in the workspace, including ones the caller cannot read).

6. **`GET /tags` moves from the bulk module to a tags module** (same route, same answer, plus `version`). The
   bulk module still owns tag attach and detach (it needs them inside its per-record savepoints), and keeps its
   statements in `@crm/db`; the new module owns reading, the chips and management. The four object services
   reach tags only through `TagsService`.

## What this does not do, on purpose

- **Tag names are visible to everybody who can read any record kind** (`GET /tags`), because a picker has to
  offer them. A tag name is therefore not a secret within a workspace; which records carry it is, and that stays
  inside record scope. Do not put a customer's name in a tag.
- Tags are not added to exports, to CSV import, or to the search index's text. Searching for a tag name finds
  nothing; filtering by tag does. A follow-up, with the same one-shared-statement approach.
- Activities do not carry tags in the UI (the table allows them; no screen asks).
- No per-record limit (Zoho caps it at five on its Standard plan). The workspace cap of 500 and the bulk cap of
  five per call remain.

## Consequences

- The `tags` field is asked of `canReadField` like any key. With no `field_permissions` row able to name it,
  it follows the grant on the object. If a field-permission row for the key `tags` were ever created, a filter by
  tag would obey it; nothing creates one today.
- A deploy that has two tags whose names differ only by case stops at migration 0025 (the new unique index), loudly,
  rather than starting with an ambiguous tag. The application has always looked tags up by lower-cased name, so none
  is expected; the table holds at most 500 rows per workspace, so the build takes no meaningful lock.
