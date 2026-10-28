# ADR-0071: Imported history is quiet by default

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

F7, the fifth of five import changes. A business moving in brings five years of contacts, deals and leads. Each
imported record writes the same `created` or `updated` event a record made in a form does, because search and
the record timeline are built from those events. If a notification, an automation or a webhook is ever
subscribed to those events, it would fire once per imported row: a hundred thousand e-mails and a hundred
thousand automation runs for history that already happened. The owner decided (2026-10-28): imported rows fire
no automations and no notifications; an opt-in can come later.

Nothing in the product subscribes to a record's created or updated event for that purpose today (notifications
follow activities; automations and webhooks do not exist yet). This decision is about the next one added.

## Decision

- **The event says where the record came from.** Every `created` and `updated` event an import writes carries
  `payload.source = 'import'` and `payload.importJobId` (`HISTORY_SOURCE`, `import-rows.ts`).
- **The relay withholds such an event from every handler registered with `on`.** A handler that has to see
  imported rows registers with `onHistory`. The default is the safe side, so a consumer added later by someone
  who never thought about imports does not fire for them; adding `onHistory` is a deliberate, reviewable act.
  An event with no eligible handler is marked relayed, not left waiting.
- **Two consumers opt in, because they keep a record's own bookkeeping true:** the search index (an imported
  record must be findable) and the record timeline.
- **The timeline says it was an import.** `Contact imported` instead of `Contact created`, and
  `Contact updated: title (by an import)`: a record whose creation date came from a file was not created on the
  day its timeline row appears.
- **Opt-in later.** When automations exist, "also run for imported rows" is a per-automation choice that
  registers its handler with `onHistory`; nothing in this change needs to be undone for it.

## Consequences

- No migration. The marker is in the event payload, which timeline entries also keep as their `detail`.
- `OutboxRelay.on` changes meaning for imported events only: handlers registered before this change that are not
  search or timeline (none exist for these event types) would stop receiving them.
- Events published by the API never carry `source = 'import'`; a payload with any other `source` is delivered
  normally (tested).
- Not covered: events of other imports' own pipeline (`import.*`), which are internal and unmarked, and the
  sample-data and restore paths, which are not history imports.
