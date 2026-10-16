# ADR-0006: Transactional outbox and domain events

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

A state change must trigger search indexing, the record timeline, notifications and
— from Phase 2 — automations, webhooks and AI (MVP_SPEC §12). Calling those side
effects inline from a service has two failure modes: the transaction commits and the
side effect is lost (a crash between the two), or the side effect fires and the
transaction rolls back (a webhook announcing a deal that does not exist).

## Decision

Every state change writes a row into **`outbox_events` in the same transaction** as
the data change. Nothing else is called inline.

A **worker** (`apps/worker`) polls `outbox_events` and relays each event to its
subscribers: search indexing, timeline projection, notifications, and later
automations and webhooks.

Services therefore **never** call an email provider, a webhook or a search index
directly. They emit an event.

## Consequences

- Atomicity: the event exists if and only if the data change committed.
- One reliable event stream serves every current and future subscriber, which is
  what makes the Phase 2 automation builder cheap to add.
- Delivery is **at-least-once**, so every consumer must be **idempotent**
  (CLAUDE.md §6). This is a real constraint on every job we write.
- Events are delivered asynchronously, so the UI must not assume a side effect has
  already happened when a write returns.
- The outbox table is hot: it needs an index on `(status, available_at)` and
  periodic archival of relayed rows.

## Alternatives considered

- **Direct calls from services.** Rejected: loses atomicity, couples every module to
  every integration.
- **Writing to a broker alongside the database.** Rejected: a write to Postgres plus
  a write to a broker is a distributed transaction, which is exactly the problem the
  outbox exists to avoid.
- **Change Data Capture (logical replication).** Powerful, but it emits row diffs
  rather than business events, and adds an operational component we do not need yet.
