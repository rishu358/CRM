# ADR-0026: An activity's owner is its assignee

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

Every other business record carries `owner_id`, and record scope (`own`,
`team`, `all`) is applied to that column (ADR-0008). MVP_SPEC §6.2 gives
activities an `assigned_to` instead: the person who has to make the call.

Having both is the obvious move, and it is the one that goes wrong. The two
columns answer the same question — "whose task is this?" — and the first time
they disagree, the person who has to do the work is the one who cannot see it:
a manager creates a task, assigns it to a rep, and the rep's `own`-scope list
quietly omits it because the manager owns the row. My Day is then empty for
exactly the people it is for.

## Decision

Activities have **no `owner_id`**. `assigned_to` is the ownership column:

- record scope is applied to it (`activities.sql-helpers.ts`);
- `can()` is given it as the record's `ownerId`;
- My Day filters on it;
- the system field metadata lists `assigned_to` and no owner.

Reassignment is governed by scope, and more permissively than for records:
`all` may assign to any active member, `team` to anyone sharing a team, `own`
only to themselves. Moving a _customer_ between reps is an `all`-scope act;
handing a colleague a task is ordinary management, and a manager who could not
give work to their own team could not do their job.

The assignee must be an **active member of the tenant**, checked in SQL. The
column is a plain uuid, so without that check an id from another tenant would
be accepted and simply never resolve.

## Consequences

- One column, one meaning. There is no case where the assignee cannot see
  their own task.
- The creator is not recorded as an owner, only as `created_by` — which is
  what that column is for, and what the audit entry says.
- Code that reaches for `owner_id` on this table will not compile, which is
  the point: anything generic over "the owner column" has to be told which
  column that is, and the sql-helper is the single place that says so.
- An unassigned activity (`assigned_to is null`) is visible only at `all`
  scope, exactly as an unowned record is elsewhere (`satisfiesConstraint`).
- If a future requirement genuinely needs "who asked for this" separate from
  "who does it", it is a new column with a new name — a watcher or a
  requester — not a second owner.
