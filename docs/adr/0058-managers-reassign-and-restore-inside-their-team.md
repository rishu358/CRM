# ADR-0058: A Manager reassigns and restores inside their team

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

The pilot simulation found two ways the default Manager role (read, create, update, delete, export, import
at `team` scope) did not do what MVP_SPEC §4 and the role's own description promise ("reassign work"):

- **F2.** `POST /ownership/preview` and `/ownership/reassign` answered 422 "You cannot assign records to
  another user" for every record type except activities, because the ownership service demanded `all`
  scope to hand a record to another person. Only an Owner or Admin could move a lead. (A test said so on
  purpose: "a manager can hand a team activity to a teammate, but not a record to anyone". It followed
  the then-current reading of "work" as tasks. MVP_SPEC §4 lists the Manager as seeing "the team's
  leads/deals, reassign work", and a CRM manager who cannot move a lead cannot do the job.)
- **F3.** A Manager could delete a teammate's record and see it in the Recycle Bin, but restore answered 404. Restore asks `can(actor, 'delete', record)` at restore time (MVP_SPEC M4) and passed a record that
  carried only its owner. `team` scope is a fact about the owner's teams, so it could never match.

## Decision

- **Reassigning follows the actor's `update` scope.** `all`: any record in the workspace, to anybody who
  can see that kind of record. `team`: records inside the actor's team reach only, and the new owner must be
  the actor or share a team with them, so a handed-over record never leaves the reach that allowed it.
  `own`: refused, as before. A named person who is outside the team is answered with the same
  "Unknown member" as a person who does not exist, so the endpoint is not a way to learn who else is in the
  workspace (CLAUDE.md §5.5). When a custom role holds `team` for some record types and `all` for others
  and the request names none, the types that are team-limited are skipped silently; that mixed case can
  still reveal that the named person exists (accepted: only custom roles with mixed scopes; the default
  roles are not affected).
- **Restore passes the owner's team ids** to `can()`, looked up at restore time, so restore is allowed
  exactly to the actors who may delete that record now. Out of scope still answers 404, never 403.

## Not changed

The single-record `ownerId` edit (`PATCH /contacts/:id` and the other three) still asks for `all` scope
(`resolveOwner`). It is the same rule for the same people, and is left for after saved views and bulk
actions land, which edit those services. Until then a Manager reassigns through `/ownership/*` only, and the
web app's reassign screen is on the administrators' People page.
