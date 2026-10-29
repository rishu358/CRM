# ADR-0069: An import can set when a record was really created

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

F7, the third of five import changes. A business moving in has contacts, accounts and leads it has held for
years. Imported today they all say "created this week", so age, "new this month" and every report that reads
`created_at` are wrong from the first day. The owner decided (2026-10-28): original dates are for Owner and
Admin only, through a permission of their own, and the real time of the import is always kept in the audit log.

Backdating is also the one import feature that lets a record claim a past other people then believe. That is
why it is its own right and not part of `import`.

## Decision

- **A right of its own: `import_history:create`.** A new administrative object type (like `pipeline`), scope
  `all` only, in the grant catalogue so a custom role can be given it. Default: Owner and Admin, by the seed for
  new workspaces and by migration 0030 for existing ones. Nobody else holds it: not Manager, not Sales Rep, not
  a custom role that looks like the owner. (The first idea, a new _action_, would have meant changing the
  action list, a database check and every permission screen for one switch; an object type is how every other
  one-off administrative right in the product is expressed.)
- **A mapping target, `created_at`, offered only to someone who holds it** (and whose field rules allow
  writing it). It is refused at the API on start and check, again by the worker for the whole job at every chunk,
  and again per row, exactly as the owner and account columns are (ADR-0067).
- **Strict dates, read in the workspace's time zone** (`original-dates.ts`). `YYYY-MM-DD` is the start of that
  day; `YYYY-MM-DD HH:MM[:SS]` is wall-clock time in the workspace zone; with `Z` or an offset it is exact.
  Anything that could mean two things (`03/04/2024`, a two-digit year) is refused, never guessed. A date in the
  future, one before 1990 (a typo, or what some tools write for an empty date), and one that does not exist
  (`2024-02-30`) are row errors that name the cell.
- **A new record only.** The date applies to a record the import creates, as its created and its last-updated
  time (nothing has happened to it since). A row that matches an existing record in `update` mode never
  rewrites that record's creation date: history already in the system is not editable from a file. A blank
  cell means "not given": the record is created now.
- **The audit trail does not take the file's word.** `audit_logs.occurred_at` is the server clock. A created
  record whose date came from a file carries `backdated: { createdAt, importedAt }` in its audit entry (the date
  the file claimed and the real moment of import), and the import's own audit entries carry `originalDates` so
  "who brought history in" is one filter.
- **A check validates dates too**, and still writes nothing (ADR-0068).

## Not decided here

- **Deals and `closed_at`.** They come with the deals import (F7-4), where the stage rules decide what a closed
  date may be. The dashboard's "won this month" reads `closed_at`, so that change gets its own decision.
- **Keeping imported history from firing automations and notifications** is F7-5.

## Consequences

- Migration `0030_import_history_grant.sql` (a backfill of role rows, nothing structural) and a migration test
  that builds companies before it, applies it and looks at who got the right.
- `ObjectType` gains `import_history`, so the access screens (role editor, who-can-see explainer) list it, and
  `docs/openapi.json` changes by one enum value.
- Reports that read `created_at` now see the original dates for imported records, which is the point. Anything
  that assumed a record's creation date is "no earlier than the day the workspace was made" no longer can.
- Risk accepted, and why it is bounded: someone with the right can make a record look old. They are Owner or
  Admin, the audit log says when they did it and with which file, and no date can be in the future or before 1990.
