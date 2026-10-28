# ADR-0064: Merging duplicate contacts and accounts

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Duplicates are easy to make and, until now, impossible to fix. ADR-0023 warns when a record looks like one that
exists; the pilot simulation (F4, F11) showed reps adding duplicates all day, unable to delete them, and with no
merge. MVP_SPEC lists "merge duplicates" as P1 and every Zoho edition has it
(docs/research/zoho-gap-analysis.md).

A merge is a delete, an edit and several hundred re-pointed rows in one request, so the danger is the one ADR-0056
named for bulk actions: it can quietly become a way to change, remove or read what a person could not one record
at a time. The facts below were read from the schema and the code, not assumed.

**A premise that does not hold, recorded so nobody builds on it.** Contacts and accounts have **no unique
constraint** on e-mail, phone, name or domain (duplicates are warned about, never refused), and
`field_definitions.is_unique` is a column nothing enforces. So a merge cannot "collide on a unique e-mail" as a
database error, and no 422 for that exists. The collisions a merge really meets are covered below: a merged value
that no longer passes the rules of an edit, a hierarchy that would become a cycle, an open erasure request, and
the unique rows that do exist (`record_tags`, `activity_links`, `deal_contacts`, `record_views`), which are
combined rather than collided.

## Decision

1. **Contacts and accounts only.** Two deals are two opportunities, so there is nothing to fold. A lead becomes a
   contact on conversion, which is where a duplicate is merged, and a converted lead's links are frozen by design
   (ADR-0022). The engine does not assume contacts and accounts are the only ones; adding leads would be a new row
   in the catalogue and a decision about their conversion links.

2. **One request, one transaction: `POST /api/v1/merges`.** `{ objectType, masterId, masterVersion, loserId,
loserVersion, fields, dryRun }`. The master keeps its id, takes the loser's value for each field named in
   `fields` (the master's otherwise), receives everything that pointed at the loser, and the loser is soft-deleted
   into the Recycle Bin. A record cannot be merged with itself, with a record of another kind (an account id given
   to a contact merge is "not found"), or with one already merged.

3. **The merge does almost none of the work itself**, so it cannot do what a single edit or delete could not. The
   master is changed through the owning module's own `updateInTx` and the loser through its `removeInTx`: `can()`
   at the actor's scope on each record (`update` on the master, `delete` on the loser), field-level write
   permission, validation, the version guard, an audit entry and an outbox event each. The search index and the
   timeline already react to those events. Everything else is a closed catalogue of statements in `@crm/db`
   (`merge/`), because the merge module may not read the activities, deals, leads or attachments tables.

4. **Reads are 404, refusals are 403.** Both records are found by id under row-level security and judged against
   `read` at the caller's scope; one outside it is "not found", in the same words as an id that does not exist.
   One the caller can read but may not change (master) or delete (loser) is a 403. Both versions are checked (409).
   The default Sales Rep holds no `delete` grant (finding F11), so cannot merge: a merge deletes the loser, and a
   rule of "a rep may merge what they could not delete" would be a way round that grant. A Manager merges inside
   their team; a role with `own` scope merges their own.

5. **Fields.** The ones that can be chosen are the standard fields the update contract has, minus the owner
   (reassignment has its own rules, ADR-0033), plus every active custom field. Each one named must be readable
   **and** writable by the caller: a field they cannot, one that is inactive and one that does not exist all
   answer `FIELD_NOT_WRITABLE`, the same words, so naming fields cannot probe which are hidden. The master keeps its
   value in any field the caller cannot choose, and the response shows the merged record as the caller may read it
   (a hidden field is absent, not null). The chosen values are validated by the object's own update schema, so a
   legacy e-mail that no longer passes an edit's rules is a clear 422, not a 500. `created_at` and `created_by`
   follow the older of the two records, because "customer since" is a fact about the relationship. A contact's
   consent is the master's, and a channel recorded only on the loser is carried over, so a merge never drops a
   recorded consent; consent is not part of the update contract, so it is not a field of the choice.

6. **What moves, and what stays.** Re-pointed, in the same transaction:
   - a contact: `deals.primary_contact_id`, `deal_contacts.contact_id`, `leads.converted_contact_id`;
   - an account: `contacts.account_id`, `deals.account_id`, `accounts.parent_account_id` (the loser's children),
     `leads.converted_account_id`;
   - both, the polymorphic `(object_type, record_id)` rows: `activity_links` (calls, meetings, tasks **and notes**,
     which are activities), `attachments`, `record_tags`, `timeline_events`, `record_views`.

   Where a unique pair would collide (a tag both carry, an activity linked to both, a deal with both people, a
   person who viewed both) the loser's copy is dropped, because the master already has the fact; a deal contact's
   role is kept where the master's has none. Soft-deleted rows move too: a deal in the Recycle Bin that is restored
   next month must not point at a record that has been folded away. A business record that now points somewhere new
   gets `version + 1`, an audit entry and a `.updated.v1` event, so an open edit gets a 409 and the search index
   follows. Left alone, on purpose: `audit_logs` and `outbox_events` (history; they name the old id and stay true),
   and a saved view's stored condition that happens to carry the loser's id as text. `search_documents` is a
   projection: the loser's rows go with its delete event. If the master was sample data (ADR-0037) and the loser
   was not, the master is deregistered, because "remove the sample data" would otherwise delete a record that now
   holds a real customer's history.

7. **A cap, and a refusal above it.** One merge moves at most **5,000 rows** across every table above
   (`MERGE_MAX_MOVED_ROWS`). They are counted first; over the cap the merge refuses with 422 `MERGE_TOO_LARGE`,
   says how many rows the records carry, and writes nothing. It is a cap on the work one request does while it
   holds both records and a connection, not on how many things a record may have; the remedy is to remove or move
   some and try again.

8. **Refusals that are about the pair.** One account above the other in the hierarchy (the one kept sits under the
   one merged away) is `MERGE_BLOCKED`: moving the loser's children under the master would make a cycle, and
   choosing a new parent for somebody is not a decision a merge may make. An erasure request that is pending or
   processing for either contact is `MERGE_BLOCKED` too: it would race the erasure (ADR-0032).

9. **Where the loser went: a table, not a column.** `record_merges` (migration 0026) holds `(object_type, loser_id,
master_id, moved counts, merged_at, undone_at)`: ids, counts and times, **no personal data**, no foreign key to
   the loser. A column on `contacts` and `accounts` would have been an `ALTER` of two tables that can be large, and
   would have died with the Recycle Bin purge at 30 days; the pointer outlives the purge, which the old link needs.
   Row-level security with the same tenant policy as every table; the application may add a row and change only
   `master_id` (collapsing a chain: when B, which had A merged into it, is itself merged into C, A's row now says C,
   so an old id is always one hop from the survivor), `undone_at` and the bookkeeping columns; it cannot delete one.

10. **The old id answers.** `GET /contacts/{id}` or `/accounts/{id}` for a merged-away record is **410
    `RECORD_MERGED`** with the survivor's id in `details`, but only when the caller could read **both** the
    merged-away record (by its owner) and the survivor; otherwise it is the plain 404 of any record they cannot
    see (CLAUDE.md §5.5). After the purge the merged-away record's owner is unknown and the survivor's visibility
    decides. Other methods on the old id stay 404.

11. **Restoring the loser from the Recycle Bin is allowed**, and what it does is defined: it comes back as a record
    of its own, with its own values (a merge never blanks the loser's), `undone_at` is set so the old id stops
    answering 410, and **what moved stays with the survivor**. A full un-merge is not built; the merge's audit entry
    has the counts and the loser's before-values, and a later merge of the same pair is allowed (a new pointer).
    The merge dialog says all of this before the person confirms.

12. **The lead trigger is relaxed for exactly one case.** Migration 0009 freezes a converted lead's links, so a
    merge could not re-point `converted_contact_id`. `leads_assert_conversion_final()` now lets a contact (or
    account) link change to a different, non-null target **only when** the old link was non-null and a
    `record_merges` row says the old target was merged into the new one, has not been undone, and was written in
    this very transaction (`merged_at = now()`, and `now()` is the transaction's start, the same in every statement
    and savepoint of it). The deal link has no carve-out. Nothing else the old trigger refused is allowed: the
    migration spec proves the permitted case and, as the application role with a hand-written statement, refuses a
    direct UPDATE with no merge behind it, a move to a record the old target was not merged into, a pointer from an
    earlier transaction, an undone pointer, a pointer for the other kind of record, a changed deal link, a changed
    state or conversion time, and a link that was NULL. The honest limit: the application role can also insert a
    `record_merges` row, so the trigger protects against a bug or a stray statement, not against the application
    itself being made to lie in the same transaction.

13. **Audit and events.** Each record gets an audit entry `merge` (master: before and after of every field the actor
    can read, plus `mergedFrom` and the counts moved; loser: the values it held, plus `mergedInto`), beside the
    `update` and `delete` entries the edit and delete wrote. Every re-pointed business record gets an `update` entry
    and a `.updated.v1` event (batched, in the same transaction). `contact.merged.v1` / `account.merged.v1` go to the
    outbox for automations and dashboards, and the timeline says it in words. Because the audit diff is written from
    what the actor may read, a hidden field is never in it, and `visibleAuditChanges` filters it again for every
    reader.

14. **Preview and retries.** `dryRun: true` runs the same code, every refusal included, and rolls back, so the
    preview cannot differ from the merge; counts are limited to the kinds of record the caller may read, and to the
    ones in their scope (`null` for a kind they cannot read at all), because a count of records somebody cannot see is
    information about them. The rows move either way. `Idempotency-Key` uses ADR-0060's mechanism: ids and counts are
    stored, never a field's value, and a retry re-reads the master as it is now. The same pair merged again under
    another key is 409 `RECORD_ALREADY_MERGED`, the answer to a concurrent double submit.

15. **Concurrency.** Both records are locked `FOR UPDATE` in id order, so A into B and B into A queue instead of
    deadlocking (the second finds its master gone: 404). The re-pointing statements can still take row locks on
    shared children in an order a concurrent edit does not share; Postgres resolves that as a deadlock error rather
    than a hang, which would be a 500 and a retry. Not seen in testing; stated, not hidden.

## Consequences

- The default Sales Rep cannot merge, and a rep who adds a duplicate still cannot clean it up until an
  administrator gives them `delete` (or a Manager merges for them). That is a business decision about F11, not a
  gap in merge; a role with `update` and `delete` at `own` can merge their own.
- The preview's counts are limited to what the caller may read; the record page's numbers and the merge's may
  differ by what the caller cannot see, and the dialog says so.
- A merged-away id answers 410 for as long as its pointer lives, which is for ever, not 30 days; the pointer holds
  no personal data, so an erasure has nothing to redact in it.
- Not built, on purpose: merging leads or deals, merging more than two records at once, automatic duplicate merging,
  a duplicate report across a whole list (the card is per record), field-by-field merge of consent, an un-merge,
  and carrying a saved view's stored id across.
