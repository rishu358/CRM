# ADR-0060: One `Idempotency-Key` mechanism for every route that creates a record

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

CLAUDE.md §6: "POST endpoints that create money/records accept an `Idempotency-Key` header." The pilot
simulation (finding F6) found that `POST /accounts` ignored it: two requests with the same key and body made
two accounts, so a retry after a dropped connection would create duplicates. The same was true of contacts,
leads, deals and activities, and of converting a lead (a retry after the first succeeded answered "already
converted" instead of the first result). Imports, exports, data-rights requests and, since ADR-0056, bulk
actions honoured the header, each with its own column or table.

ADR-0056's bulk actions already built the right mechanism: a lock, a lookup, the work and the stored note all
in one transaction, keyed by person and key, with a request fingerprint. It lived inside the bulk module.

## Decision

- **That mechanism becomes a platform service**, `IdempotencyService.once(tx, actor, key, operation, request,
work, replay)`, shared by the bulk actions and by every create route. No new table: it uses `bulk_operations`
  (migration 0023), whose name predates its general use. A rename would be a migration with nothing to gain
  but a name.
- **It stores a reference, not the answer.** What is kept for a create is the id of the record (for a lead
  conversion also the ids it made or linked, whether each was created, and the names of the fields it could not
  copy). No field of any record is stored. A replay **re-reads the record through the same read path and
  serializer as `GET`, as the same person**, so it shows the record as it is now and honours field permissions
  as they are now. There is no copy of personal data to expire, to find for an erasure request, or to outlive a
  permission change.
- **Behaviour.** The same key with the same request returns the first answer and writes nothing (no second
  record, audit entry or event), with `Idempotent-Replayed: true`. The same key with a different request
  (body, route or record) is `409 CONFLICT`, as it is for bulk actions. Requests racing on one key wait for each
  other on an advisory lock and so create one record: the later ones are answered as replays rather than being
  refused. A request that fails stores nothing, so the retry can succeed. Without a key nothing changes. If the
  record has been deleted since, or the person can no longer read it, the replay answers `409
IDEMPOTENT_RECORD_UNAVAILABLE`, not a 404 that would look as though the first request created nothing. A key
  belongs to one person in one workspace (row-level security plus the table's restrictive policy plus named
  statements). The existing key rules apply: 1 to 128 of letters, digits and `_ . : -`, and a key is not logged.
- **Routes covered:** `POST /accounts`, `/contacts`, `/leads`, `/deals`, `/activities` and
  `POST /leads/{id}/convert`. The bulk actions keep the same table and the same rule (they already carried the
  header). The duplicate warning (ADR-0023) and the key therefore cannot be bypassed by bulk: bulk edit, assign,
  delete and tag create nothing, and each of them goes through the object's own `updateInTx` and `removeInTx`.
- **The reference is stored in the transaction that created the record**, so the record and its key exist
  together or not at all. An interceptor that stored something afterwards would leave a window in which a crash
  made the retry a duplicate.
- **Retention.** Keys are remembered for `IDEMPOTENCY_WINDOW_HOURS` (24 hours, in `@crm/core`). A person's older
  keys are deleted whenever they next use one, and the Recycle Bin purge sweep, which already runs once a day
  per workspace, deletes everything older than the window.

## Not covered, and why

Roles, teams, custom fields, saved views, tags and pipelines have a unique name, so a repeated create is
refused with 409 rather than duplicated. `POST /activities/{id}/links` is unique on its pair. **Invitations and
attachment uploads have no natural uniqueness** and still ignore the header; they create a pending row and
an e-mail or an upload slot, not a customer record, and are a follow-up.

## Consequences

- A replay shows the record as it is now, so after somebody edits it the retry's answer has the newer version.
  That is the point of re-reading, and what a client that retries should expect.
- The web app does not yet send a key on its own saves. The proxy forwards the header, so a client that sends
  one benefits; making the forms send one per attempt is a separate change.
