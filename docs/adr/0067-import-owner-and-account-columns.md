# ADR-0067: An import can name the owner and, for a contact, the account

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Pilot finding F7: a business moving in could not bring its records over in a usable shape. A contact import
could fill a name, e-mail, phone and the like, but could not link the contact to an account, and every imported
row was owned by whoever ran the import. The first two weeks of a pilot are spent exactly here. ADR-0029 refused
`owner_id` on purpose: "a file must not reassign records", and an `own`-scope rep must not be able to push rows
into a colleague's book or out of their own sight. That reason still holds for those people. The owner
(2026-10-28) decided the rest: an owner column is honoured only for people who may reassign records at their
scope, everyone else's rows belong to the importer, and an unknown or out-of-scope owner is a clear row error.

This is the first of five import changes (original dates, a dry run, deals, quiet history follow as separate
decisions and pull requests).

## Decision

Two **link columns** are importable, on conditions. A spreadsheet has no ids, so each is given by something a
person can type.

| Column       | Objects                | The cell holds                          | Offered, and accepted, only if the importer                                                                                                                                             |
| ------------ | ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`   | contact, account, lead | the e-mail address of an active member  | may reassign records of that kind: `update` at `team` or `all` scope **and** the owner field writable (the rule `OwnershipService` applies); and the target is someone that rule allows |
| `account_id` | contact                | an account's name (exact), domain or id | may read accounts and may write the reference                                                                                                                                           |

- **Same rule as reassignment, not a second one.** `canImportLink` in `packages/core` is the importer's side
  (checked when a mapping is offered, when a job starts, and again at every chunk with the permissions loaded
  then); `import-links.ts` in the worker is the target's side: an active member who can see that kind of
  record and, on `team` scope, the importer themselves or a teammate. A non-privileged importer is not
  offered the column, is refused if they submit it, and is refused again per row if a hostile mapping reaches
  the worker.
- **Lookups are inside the importer's reach and say the same thing for "missing" and "not yours".** An account
  is found only among accounts the importer may read; a colleague's account, another workspace's account and an
  account that does not exist all answer `Account: no account matches "..."`. An owner outside the team, a
  non-member and a suspended member all answer `Owner: unknown member`, so a file is not a way to learn who
  works here (CLAUDE.md §5.5). The one more specific message, "that person cannot see this kind of record", is
  the one the ownership service already gives.
- **Nothing is guessed.** Two accounts with one name, or one account's name that is another's domain, fails the
  row and says so; the person uses the domain or id. Name matching is exact, because a case-insensitive match
  would not use the name index.
- **Resolved once per chunk.** The distinct values of a 500-row chunk are looked up with one query each
  (members, accounts by id, by domain, by name), not once per row.
- **Blank means nothing.** A blank owner cell leaves the importer as owner (create) or the owner unchanged
  (update); a blank account cell leaves the link unchanged. A row that changes an existing contact's owner or
  account is an update like any other: version bumped, audited with the import job id, `contact.updated.v1`
  emitted.
- **The audit entry of a created record now also carries `accountId`**, next to the owner it already carried.

## Consequences

- No migration, no new permission, no new setting: the rule reuses existing grants and field permissions.
- ADR-0029's "every imported record is owned by the importer" is now "unless a permitted importer maps an
  owner". The tests that said an owner mapping is refused now use an `own`-scope importer.
- The importer can be a `team`-scope manager handing rows to their team, or an administrator handing rows to
  anyone who can see them. It cannot be used to move a record out of the importer's own reach on a scope that
  forbids it.
- Not covered here, by design: deals (no import yet), original dates, dry run, templates, and keeping imported
  rows from firing automations. Each is its own decision.
