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

ADR-0056's bulk actions already built the right mechanism: a lock, a lookup, the work and the stored answer all
in one transaction, keyed by person and key, with a request fingerprint. It lived inside the bulk module.

## Decision

- **That mechanism becomes a platform service**, `IdempotencyService.once(tx, actor, key, operation, request,
work)`, shared by the bulk actions and by every create route. No new table: it uses `bulk_operations`
  (migration 0023), whose name predates its general use. A rename would be a migration with nothing to gain
  but a name.
- **Same behaviour as the bulk actions, for creates:** the same key and the same request returns the first
  answer and writes nothing (no second record, audit entry or event); the same key with a different request
  (different body, route or record) is `409 CONFLICT`; requests racing on one key wait for each other on an
  advisory lock and so create one record; a request that fails stores nothing, so the retry can succeed;
  without a key nothing changes. A key belongs to one person in one workspace (row-level security plus the
  table's restrictive policy plus named statements).
- **Routes covered:** `POST /accounts`, `/contacts`, `/leads`, `/deals`, `/activities` and
  `POST /leads/{id}/convert`. Each takes the header, validated by the existing `parseIdempotencyKey`.
- **The answer is stored in the transaction that created the record**, so the record and its key exist
  together or not at all. An interceptor that stored the answer afterwards would leave a window in which a crash
  made the retry a duplicate.
- **Retention.** A stored answer holds a copy of the record, so it is kept for `IDEMPOTENCY_WINDOW_HOURS`
  (24 hours, now in `@crm/core`). A person's older answers are deleted whenever they next use a key, and the
  Recycle Bin purge sweep, which already runs once a day per workspace, deletes everything older than the
  window, so nothing outlives it by more than one sweep interval. The stored answer was built for that
  person with their field permissions applied, and is only ever returned to them.

## Not covered, and why

Roles, teams, custom fields, saved views, tags and pipelines have a unique name, so a repeated create is
refused with 409 rather than duplicated. `POST /activities/{id}/links` is unique on its pair. **Invitations and
attachment uploads have no natural uniqueness** and still ignore the header; they create a pending row and
an e-mail or an upload slot, not a customer record, and are a follow-up.

## Consequences

- A person erased under a data-subject request (ADR-0032) can have a copy in a stored answer for up to 24 hours
  plus a sweep interval. The erasure does not look in `bulk_operations`; the retention window is the bound.
- The web app does not yet send a key on its own saves. The header is forwarded by the proxy, so a client that
  sends one benefits; making the forms send one per attempt is a separate change.
