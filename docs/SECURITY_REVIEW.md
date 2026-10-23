# Security self-review

Required by CLAUDE.md §11.5 after each module. This covers the foundation plus
the Contacts, Auth, Accounts, Invitations, Deals, Leads, Activities, Search,
Import/Export and Audit/Recycle Bin/Data Rights modules, and the users, roles
and permissions administration with the access explainer (M3), reviewed against
§5 rule by rule.

Reviewed: 2026-10-19 · Scope: `packages/core`, `packages/db`, `apps/api`,
`apps/worker`, `apps/web` (Accounts, Contacts, Auth, Invitations, Deals, Leads,
Activities/My Day/Notifications, global search and the command palette, import
and export with the object-storage package, the audit viewer, the Recycle Bin,
DPDP/GDPR data rights, and the generated OpenAPI document).

## §5 rule by rule

| #   | Rule                                                             | State                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation: `tenant_id` + RLS, `SET LOCAL`, no `BYPASSRLS` | **Met**                  | `0004_rls_policies.sql`; 28 tests in `rls.security.spec.ts`, including a meta test that fails if any table with `tenant_id` lacks `ENABLE`+`FORCE` — which `search_documents` has too, and which is why two text operators had to be marked `LEAKPROOF` for search to use an index at all (ADR-0028 §7, below) **Migration 0017 withdrew the application role's blanket UPDATE on `tenants`** (it could have rewritten `plan`, `status`, `slug` or `region`; RLS limited the row, not the column): it now holds UPDATE on six profile columns only, proved in `onboarding.security.spec.ts`. `sample_records` has RLS, isolation tests and no UPDATE grant (ADR-0037).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | Never trust the client for tenant, user, role, ownership         | **Met**                  | Actor built only in `ActorService` from session + memberships; `X-Tenant-Id` is re-checked against membership; `resolveOwner` refuses reassignment without `all` scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | Every endpoint authorized via `can()`, default deny              | **Met**                  | `AuthGuard` is global; routes are protected unless `@Public()`. A lint rule rejects inline role comparisons Company setup and sample data are authorized against `tenant_settings`, with a per-kind create (loading) or delete (removal) check on top; the worker re-checks the requester when it runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | Field-level permissions applied in the serializer                | **Met**                  | `contacts.serializer.ts`, `accounts.serializer.ts`, `deals.serializer.ts`, `leads.serializer.ts`, `activities.serializer.ts` (which also re-sanitizes the rich-text body on the way out, ADR-0024); hidden fields omitted (not nulled) and rejected on write. Sorting and filtering are checked too (`common/field-queries.ts`): a column the caller cannot read cannot be ordered by or compared against either. Global search applies the same rule twice over — a hidden field is not matched on, in SQL, and `search.serializer.ts` re-checks the matched field before quoting it (ADR-0028)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | No IDOR; 404 not 403 outside scope                               | **Met**                  | `assertCan` maps out-of-scope to 404; a test asserts the 404 for a foreign record is byte-identical to one for an id that does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | Zod validation at the boundary, unknown keys rejected            | **Met**                  | `.strict()` contracts; a body carrying `tenantId` is a 422. Rich text is additionally sanitized against an allow-list on write **and** on read (`@crm/core/html`, ADR-0024), with 46 payload tests in `html.spec.ts` and 9 stored-XSS tests through the API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | No SQL string concatenation; whitelisted sort/filter             | **Met**                  | `contacts.sql-helpers.ts`, `accounts.sql-helpers.ts`, `deals.sql-helpers.ts`, `leads.sql-helpers.ts` and `activities.sql-helpers.ts` resolve every client-supplied key against field metadata; accounts also checks the filter **value** against the column type, so a bad one is a 422 rather than a driver error surfacing as a 500. Injection attempts through `sort` and `filter` are tested in both modules. Global search tokenizes the caller's string to bare words in `@crm/core` before any query language sees it, so no `&`, `\|`, `!`, `:` or quote reaches `to_tsquery`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Secrets from the environment; never logged                       | **Met**                  | Validated env modules are the only readers; pino redaction list; `.env` is git-ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | Secure cookies, CSRF, MFA, rate-limited auth, revocation         | **Met**                  | Cookie is httpOnly/SameSite=Lax/Secure-in-prod, set server-side and never readable by page script (an E2E test asserts `document.cookie` and both web storages); CSRF origin checks on both cookie-authenticated routes; TOTP + backup codes with tenant-level enforcement in `AuthGuard`; progressive delay in `AuthThrottleService` plus a per-IP ceiling in `AuthRateLimitGuard`; revocation via `session_epoch` bump, see ADR-0036                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | Audit create/update/delete, logins, exports, role changes        | **Met**                  | Accounts, Contacts, Deals, Leads and Activities CRUD (including attaching and detaching a polymorphic link) (a stage move included, with both stages in the diff; a lead conversion audited on the lead **and** on every record it creates), login, logout, password changes, **plus every invitation, acceptance and revocation**, each audited in the same transaction and append-only by withheld grants. A password change is audited in every workspace the user belongs to, because it affects access to all of them. **Import jobs (created, started, completed with counts) and every imported record (tagged with its job id), and every export (requested, finished with the row count, each download link issued)** are audited the same way. **Every permission change (M3):** a role’s grants and field rules (`permission_change`, carrying exactly the cells that moved as `{ old, new }`), a person’s role or suspension, a team’s membership (and a team’s deletion, because people reach records through it), and every reassignment of ownership (an `update` on each record, with the old and new owner). Each is written in the **same transaction** as the change — a change refused for escalation, for leaving no administrator, or for a stale preview writes no audit row either, and the tests assert that — and an outbox event beside it (`role.permissions_changed.v1`, `membership.updated.v1`, `team.members_changed.v1`). Proved in `access.spec.ts` ("audits it as a `permission_change`, in the same transaction, with exactly the cells that moved"; "writes nothing, audit included, when the change is refused"). **This was the last Partial row.** **M11 adds the reading half: `GET /audit-logs` for roles holding `audit_log:read` at `all` scope, with each diff filtered through the same `canReadField` as every other read path (`visibleAuditChanges` in `@crm/core`, 18 tests in `audit-log.security.spec.ts` and 12 in `visibility.spec.ts`), plus `restore`, `purge`, `erase` and `redact` entries for the Recycle Bin and data rights, and three new archive kinds audited on request, on completion and on each link issued. The query shape is asserted against the planner in `audit-query.perf.spec.ts` (ADR-0034).** Company profile edits (old and new), setup completion, and sample data being loaded or removed (`sample_data_loaded`, `sample_data_removed`, plus a `create` or `purge` row per record). |
| 11  | CSV export with formula-injection escaping                       | **Met**                  | `toExportCell` is the only route to an output file: every cell of the CSV and XLSX writers, the header row, and the import error file (which echoes the uploader's own cells), with no list of "columns to escape". Decided on the first non-whitespace character, so a leading space, NBSP or zero-width space does not hide a payload. Each trigger (`=` `+` `-` `@` tab CR, and LF) and each whitespace character is its own test on a system column, a custom field, a header and **imported data** (`export.security.spec.ts`), then the whole file is scanned. `export` is its own action, scoped, field-filtered, audited. **The three M11 archives go through the same writer: an audit-log CSV escapes every cell including the rendered diff, which holds values a user typed (`archive.security.spec.ts`). The whole-tenant and one-person archives are JSON only — a multi-table archive flattened into one CSV loses the links that make it answerable, and a zip of one file per table is the right shape and is deliberately not built (the API returns 422 rather than producing a lossy file).** ADR-0030 §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | File type by magic bytes, presigned URLs                         | **Met**                  | For every file that exists (import uploads, generated exports, error files, **record attachments**): magic bytes **and** claim-vs-bytes, from one shared signature table (`files/signatures.ts`, read by both `magic-bytes.ts` and `files/attachments.ts`); size signed into the presigned PUT; zip bombs measured, not declared (`zip.ts`); random keys; 5/10-minute presigned URLs; the API never reads or writes bytes (counted in tests); tampered size, type, key and expiry refused by a real MinIO. **Attachments reuse that path in full** and add the three things a user-supplied file downloaded by other users needs: a closed extension allow-list with no `svg`, `html` or `xml` on it, a canonical content type the server picks from the extension (the contract has no `mime` field), and a filename that is refused on write — separators, `..`, control characters, bidi overrides, over 255 characters — then sanitised again by `safeDownloadName` before it reaches an always-`attachment` `Content-Disposition`. The byte check runs in the worker, against the object as it is _then_, so a swap after confirmation is caught. The M11 archives use the same signing path under a separate `data-exports` key prefix, so an operator can give them their own lifecycle rule. A record hard-deleted by the Recycle Bin retention sweep publishes `<object>.purged.v1`, and `pruneAttachments` is subscribed to it as well as to `.deleted.v1`, so purging a record deletes its files rather than orphaning the bytes (ADR-0034 §7). ADR-0030, ADR-0035                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | SSRF protection on outbound requests                             | **Built, no caller yet** | `@crm/core` outbound rules and `@crm/outbound`'s guarded client (ADR-0040); `boundary.spec.ts` fails if anything else opens a connection. Becomes **Met** when the first feature that takes a destination goes through `OutboundHttp`. See "Outbound requests and the browser's policy"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 14  | Rate limit per tenant **and** per user                           | **Met**                  | Per user and per tenant in `AuthGuard`, keyed on the session-proven user and membership-proven tenant (so neither can be spoofed), per address before authentication; all counted in Redis so they hold across API instances (ADR-0042)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 15  | Say so when unsure                                               | —                        | This document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Invitations (MVP_SPEC M2), reviewed

The module is the first thing in the product that writes a second
`memberships` row, so the whole permission engine only becomes reachable in
production because of it. Three decisions in it are security decisions, and all
three are written down in [ADR-0019](adr/0019-invitation-acceptance-identity.md)
rather than left implicit in the code.

| Question                                                       | Answer, and where it is proved                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a token join a workspace it was not issued for?            | No. The workspace is on the invitation's row; the token's prefix is a routing hint whose only effect is choosing an RLS context, so a swapped prefix matches no digest. `invitations.security.spec.ts` "cannot be pointed at another workspace"             |
| Can a token confer a role it was not issued with?              | No. `role_id` is read from the row at redemption and appears in no request body; the contracts are `.strict()`, so sending one is a 422. "confers only the invited role, whatever the recipient asks for"                                                   |
| Can somebody accept an invitation that is not theirs?          | No. Every identity check runs before the redeeming UPDATE, so a refused attempt leaves the link usable by the real recipient. "refuses somebody signed in as a different address, and leaves the link usable"                                               |
| Can an emailed link produce a session for an existing account? | No — that would walk past a second factor its owner enrolled. The recipient signs in first. "never issues a session from a link when the address already has an account"                                                                                    |
| Does inviting reveal whether an address has an account?        | No. The response is the invitation either way; the difference is only in the mail that address receives. The acceptance screen does say so, but only to somebody already holding a token mailed there (ADR-0019)                                            |
| Is the token ever readable back out of the API?                | No. Only its SHA-256 is stored, and `InvitationRow` has no field for either — so an administrator cannot read a colleague's link and redeem it. "keeps the secret and its digest out of every response"                                                     |
| Can an invitation undo a suspension, or re-role a member?      | No to both. A suspended membership is a 409, and an invitation accepted by an existing active member is spent without touching their role. Two tests                                                                                                        |
| Does an unaccepted membership grant anything?                  | No. `ActorService` has always required `status = 'active'`; invitations are the first thing that can produce another state, so there is now a test that says so                                                                                             |
| Is a link single-use, expiring, and retired by a newer one?    | Yes, all three. Redemption is one guarded UPDATE, so two concurrent acceptances cannot both win; a second invitation to the same address marks the first `superseded`. Four tests, plus an E2E that spends the seeded link and then fails to spend it again |

The four mandatory suites from CLAUDE.md §10 are in
`invitations.security.spec.ts`: tenant A cannot list, read or act on tenant B's
invitations (and gets a 404 identical, request id aside, to one for an id that
never existed); a user without the grant is refused the list, the invite and
the revocation; the token and its digest never appear in a response;
unauthenticated requests get 401.

### What is deliberately public

`GET` and `POST /api/v1/invitations/accept` are `@Public()`, because the
recipient may have no account yet. They are not unauthenticated — the token in
the link is the credential — and they carry `AuthRateLimitGuard`, the same
per-source ceiling sign-in has, because a link with a secret in it is worth
guessing at.

## Deals (MVP_SPEC M5), reviewed

The first object with **configuration it depends on** (pipelines and stages),
the first with **money that is aggregated** (the board's column totals), and the
first with **several columns that take an id from the client** (`stageId`,
`pipelineId`, `accountId`, `primaryContactId`, and a set of contacts). Each of
those is a way to cross a boundary that a plain record does not have. Two
decisions are written down in
[ADR-0020](adr/0020-deal-stage-transitions.md) and
[ADR-0021](adr/0021-currency-conversion-seam.md).

| Question                                                                       | Answer, and where it is proved                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a deal be pointed at another tenant's stage, pipeline, account or contact? | No. Every reference is a composite key on `(tenant_id, …)`, and the stage key also carries the pipeline, so "stage belongs to this deal's pipeline" is structural. The service answers a foreign id and a missing one with the same bytes. `deals.security.spec.ts` "cannot plant another tenant stage or pipeline", "…account or contact", and the two "says the same" tests |
| Can the closed state be set without moving the deal?                           | No. `closedAt` is not in the contract (a 422), and the stage decides it (ADR-0020). A trigger refuses any row — from an import, a seed, anything — that disagrees with its stage. `deals.spec.ts` "the database refuses what the service would"; `stage-rules.spec.ts`                                                                                                        |
| Does the board's total reveal a hidden amount?                                 | No. A caller who cannot read `amount` gets counts and no totals; `currency` is not sortable or filterable either, since it is half of `amount`. "gives no board totals to a caller who cannot read the amount"; "does not offer currency as a way round the amount permission"                                                                                                |
| Does the board's total reveal a colleague's deals?                             | No. The aggregate carries the record-scope predicate in its WHERE clause, as the list does. "keeps a colleague deals out of the board totals and counts" asserts the board count equals the rep's own list                                                                                                                                                                    |
| Is a drag a write that field permissions apply to?                             | Yes. A move writes `stageId`, so a `read`-only permission on `stage_id` refuses it with 403 and leaves the deal where it was. "refuses a move by a caller who can read the stage but not write it"                                                                                                                                                                            |
| Can a rep drag a colleague's card?                                             | No. The PATCH is a 404, and the stage is unchanged in the database. "returns 404 when the rep reads, moves or deletes a colleague deal"                                                                                                                                                                                                                                       |
| Can two drags of one card both win?                                            | No. The update carries the version the card was read at; two simultaneous drags produce exactly one 200 and one 409. "serialises two simultaneous drags". The web app queues moves so a second drag carries the version the first produced                                                                                                                                    |
| Can money lose precision on the way?                                           | No. Amounts are bigint minor units and travel as strings; rates are `numeric` read as strings and applied in bigint. A value past 2^53 round-trips exactly; one past the bigint range is a 422 rather than a 500                                                                                                                                                              |

The four mandatory suites from CLAUDE.md §10 are in `deals.security.spec.ts`:
tenant A cannot list, read, move or delete tenant B's deals, and cannot read
its board or pipelines; a user with `own` scope sees only their own deals, on
every page of a nullable sort and in the board counts; a hidden `amount` and
`lost_reason` are absent from the record, the list and the board, rejected on
write (create and update), and cannot be sorted or filtered on; and
unauthenticated requests get 401 on every route including the board.

### What building Deals changed

- **The Contacts template's soft delete did not touch `updated_at`.** A deleted
  record's `updated_at` therefore still says when it was last _edited_, which is
  the wrong answer for a Recycle Bin sorted by "deleted". Deals sets it;
  `contacts.repository.ts` and `accounts.repository.ts` still do not. It is a
  one-line change in each, left alone here because it is outside this module,
  and worth taking before the Recycle Bin is built.
- **A cache lookup that assumed every `deals` query held a list.** Found by the
  Playwright suite, not by review: the optimistic move read "the newest copy of
  this deal" from every cached query under the `deals` key, and the board's
  totals live under the same key with a different shape, so the first drag
  threw. Narrowed to the paged queries; the suite's refused-move test covers it.
- **Playwright's drag scrolls the board while the button is held.** With a drop
  target off screen it picked up one card and dropped another. A browser
  auto-scrolls during a real drag; the suite uses a viewport wide enough to show
  every column, so it tests the board rather than the difference. Recorded
  because the next person to write a drag test will meet it.

Decisions recorded rather than fixed:

- **Linking an account or a contact is tenant-scoped, not record-scoped.** The
  same call accounts made for a parent (above): a rep with `own` scope must be
  able to put their deal under an account a colleague owns, and attaching an id
  reveals nothing, since reading it still goes through its own module.
- **Pipelines are read-only in this module.** Tenants get a seeded default and
  the demo tenant gets a second; creating or reshaping one is an admin feature
  needing its own permission object (pipelines are configuration, not records),
  which is a decision for M3 and M9 and not one to make as a side door through
  the `deal` grants.

## Leads (MVP_SPEC M4), reviewed

The first object whose main operation **writes to three other modules'
tables**, and the first feature that **searches other people's records on a
value the caller typed** — conversion and duplicate detection. Both are ways to
cross a boundary a plain record does not have: conversion can move a value into
a field the caller may not write, and duplicate detection can answer "does a
record with this email exist" for a record the caller may not read. Two
decisions are written down in
[ADR-0022](adr/0022-lead-conversion.md) and
[ADR-0023](adr/0023-duplicate-detection.md).

| Question                                                                | Answer, and where it is proved                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a duplicate match surface another tenant's record?                  | No. RLS applies to each owning module's query. Tenant B holds a lead, contact and account with the caller's exact email, phone and company; the check returns nothing and the response contains none of their ids or names. `leads.security.spec.ts` "never offers another tenant record as a duplicate, on any field", and the same on create                      |
| …or a colleague's record outside the caller's scope?                    | No. The reader's `own`/`team`/`all` constraint is a `WHERE` clause in the lead, contact and account queries, not a filter on fetched rows. The colleague, who may read them, is offered all three; the `own` rep is offered none, and the answer equals the one for an email nobody holds. "duplicate detection respects the actor record scope" (7 tests)          |
| Can a match probe a field the caller may not read?                      | No. A hidden `contact.phone` is not matched on, a hidden lead value is not used to look, and the label is built from readable fields only. "does not match on a hidden field…", "does not use a hidden lead value…", "builds match labels only from fields the caller may read"                                                                                     |
| Can a conversion link to another tenant's, or an out-of-scope, record?  | No. Composite foreign keys on `(tenant_id, …)` make a cross-tenant link structural, and the service additionally requires the target to be in the caller's record scope. Another tenant's id, a colleague's and a nonexistent one give the same 422. "cannot link a conversion to another tenant contact or account"; "refuses to link … colleague out-of-scope …"  |
| Can a conversion be half done?                                          | No. One transaction; the lead is updated last under a version-and-status guard. A failure at the deal step leaves no contact, account, audit row or event; a role that may not create deals gets a 403 and a clean rollback; two simultaneous conversions produce one 200, one 409 and one contact. `leads.spec.ts` "is one transaction…" (×2), "lets exactly one…" |
| Can a conversion move a value into a field the caller may not write?    | No. A value is copied only if the caller may read it on the lead and write it on the target; otherwise it is left behind and reported in `skippedFields`. "reports fields it could not copy instead of dropping them silently"                                                                                                                                      |
| Can a converted lead be changed, re-converted or re-pointed?            | No, by any writer. The service answers 409; `status` cannot be sent as `converted`; and the database refuses it with a `CHECK` and a trigger, so an import or a seed meets the same wall. `packages/db` `leads.security.spec.ts` "a conversion is permanent"; `leads.spec.ts` "refuses to convert or edit a lead that is already converted"                         |
| Can the "create anyway" acknowledgement be skipped by a non-web client? | No. The API refuses to create a matching contact or account without `acknowledgeDuplicates: true` (409 `DUPLICATE_RECORDS`). The M4 acceptance criterion has its own named test: "converting a lead whose email matches an existing contact offers "link to existing" rather than silently creating a duplicate"                                                    |

The four mandatory suites from CLAUDE.md §10 are in
`apps/api/src/modules/leads/leads.security.spec.ts` (34 tests) and, at the
database, `packages/db/src/leads.security.spec.ts` (15 tests): tenant A cannot
list, read, update, delete, convert or read conversion matches for tenant B's
leads; a user with `own` scope sees only their own leads on every page of a
nullable sort and cannot convert a colleague's; a hidden `phone` is absent from
the record and the list, rejected on write (create and update), and cannot be
sorted or filtered on; and unauthenticated requests get 401 on every route,
including the duplicate check and conversion.

### What building Leads changed

- **`create` in contacts, accounts and deals became `create` + `createInTx`.**
  Conversion needs the same checks, audit entry and outbox event as a normal
  create, inside its own transaction. The bodies were moved, not copied, and
  the existing suites for all three modules pass unchanged.
- **The duplicate matchers live in the contacts and accounts modules**
  (`findDuplicates`, `assertReadableForLinking`), not in leads, because only the
  owning module may query its table (ADR-0001) and only it can apply its own
  scope and field rules.
- **`Sales Rep`, `Manager`, `Admin`, `Owner` and `Read-only` gained lead
  grants** at the same scopes they hold for the other business objects
  (`BUSINESS_OBJECTS` in `seed/roles.ts`), and `lead` field metadata was added to
  provisioning. Tenants created earlier have neither; see the first gap below.
- **A new error code**, `DUPLICATE_RECORDS` (409), added to `ErrorCode`.
  Additive, so within the v1 compatibility rule.
- **The worker now projects lead events**, and `contact.linked_from_lead.v1`
  and `account.linked_from_lead.v1`, onto record timelines. Account _created_
  events are still not projected (pre-existing, below).

Decisions recorded rather than fixed:

- **A rep with `own` scope is not warned about a colleague's matching contact.**
  The price of not building a tenant-wide directory (ADR-0023 §3). A manager-run
  duplicate report is the remedy, and is P1.
- **A `team`-scope manager converting a rep's lead owns the new records.**
  `team` scope cannot reassign (§5.2), and conversion is not allowed to launder a
  reassignment (ADR-0022 §5).
- **Linking requires record scope, where the deal module's linking requires only
  the tenant.** Deliberate: a deal pointing at a colleague's account reveals
  nothing, whereas adopting a contact as the person a lead became does.

## Activities, My Day and notifications (MVP_SPEC M6), reviewed

The first feature built on the polymorphic pair ADR-0005 put in place, the
first that **stores markup one user typed and renders it to another**, and the
first consumer of the outbox beyond the timeline projection. Each of those is a
new way to cross a boundary, and each has a decision written down:
[ADR-0024](adr/0024-rich-text-sanitization.md) (sanitization),
[ADR-0025](adr/0025-reminder-and-digest-scheduling.md) (scheduling) and
[ADR-0026](adr/0026-activity-ownership-is-the-assignee.md) (ownership).

| Question                                                              | Answer, and where it is proved                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is a polymorphic link a way around record scope?                      | No, in both directions. A link is only **created** when the target resolves for the actor, and only **shown** when it resolves for the reader. A rep handed a task that is attached to a colleague's contact sees the task and `links: []` — no null, no placeholder — while the link row is still there for those who may see it. `activities.security.spec.ts` "a polymorphic link is not a way around record scope" (5 tests) |
| Can a link be made to another tenant's record?                        | No. The target is resolved through the owning module's service under RLS and the caller's scope, so a cross-tenant id gives the same 422 as one that does not exist: "That record does not exist". No `activity_links` row appears in either tenant                                                                                                                                                                              |
| Can "the activities on this record" be used to probe for a record?    | No. The record must resolve for the caller first; otherwise 404 — not an empty page, which is also what "no activities yet" looks like                                                                                                                                                                                                                                                                                           |
| Can a stored XSS payload reach another user's browser?                | No. The body is sanitized with an allow-list before it is stored and again in the serializer, so a row written by an import, a seed or a restore is still safe to render. Script tags, `javascript:` and `data:` URLs, `onerror`, SVG, `<math><annotation-xml>`, `<style>` and inline `style` are all covered, in `html.spec.ts` and again end to end through the API                                                            |
| Who may be given work?                                                | `all` scope anyone active in the tenant, `team` scope anyone sharing a team, `own` scope only themselves — checked in SQL against `memberships`, so an id from another tenant cannot be written into `assigned_to`. "cannot push work onto another rep"                                                                                                                                                                          |
| Can somebody read another person's notifications?                     | No, and there is no parameter to try it with: every query is `user_id = <session user>` in SQL, and marking a colleague's or another tenant's notification read is a 404. "notifications are readable only by the person they are addressed to" (4 tests)                                                                                                                                                                        |
| Does My Day leak a colleague's work?                                  | No. It filters on the viewer's own id regardless of scope, so even an `all`-scope admin sees only their own day. "My Day shows only the viewer's own work even for an admin"                                                                                                                                                                                                                                                     |
| Can "recently viewed" be stuffed with a record the caller cannot see? | No. A view is only recorded when the record resolves for the caller, and the list is **re-resolved on every read**, so a record since deleted, reassigned out of scope or relabelled by a field permission drops out rather than lingering with a stale label                                                                                                                                                                    |
| Is "today" the right today?                                           | Yes, in the viewer's IANA zone, from `@crm/core/activities` (`dayWindowFor`, `upcomingEnd`). An unknown zone is a 422, never a silent fall back to UTC — that would shift every bucket by a day without an error. Tested at the boundary with Kolkata (+5:30) and a 25-hour DST day, and through the API with a task at 18:45Z landing in different buckets for two viewers                                                      |
| Can a reminder fire for something that no longer wants one?           | No. The scheduled event is re-checked against the activity when it fires: completed, deleted, reassigned or rescheduled all produce silence (ADR-0025). Four worker tests, one per case                                                                                                                                                                                                                                          |
| Can a redelivered event notify somebody twice?                        | No. `notifications.source_event_id` is unique per tenant and the insert does nothing on conflict, so the second delivery writes nothing. "does not notify twice when the same event is redelivered"                                                                                                                                                                                                                              |
| Does the digest email leak anything, or render markup?                | It carries only what the notification payload holds — a subject and a link to My Day — and every value is escaped with `escapeHtml` before it reaches the HTML part. "escapes a subject that contains markup"                                                                                                                                                                                                                    |
| What happens to links when a record is deleted?                       | A soft delete leaves them, because the record can come back from the Recycle Bin and its tasks should come back attached. A record that is **really** gone takes its links and its recently-viewed rows with it, in a worker reacting to the delete event — which is the orphan cleanup ADR-0005 said this design owes. Three worker tests, including one proving the sweep stays inside its tenant                              |

The four mandatory suites from CLAUDE.md §10 are in
`apps/api/src/modules/activities/activities.security.spec.ts` (37 tests):
tenant A cannot list, read, update, delete, link to or record a view of tenant
B's activities and records; a rep with `own` scope sees only the activities
assigned to them and cannot update, delete or reassign a colleague's; a hidden
`body` is absent from the record, the list **and** My Day, rejected on write,
and cannot be sorted or filtered on; and unauthenticated requests get 401 on
every route, including My Day, record views and notifications.

### What building Activities changed

- **`activity` became a business object in the permission model.** The five
  system roles gained activity grants at the scopes they already hold
  (`BUSINESS_OBJECTS` in `seed/roles.ts`), and `activity` field metadata was
  added to provisioning. Unlike the lead rollout, **tenants that already exist
  are backfilled** by `0010_activities_module.sql`, which copies each role's
  _contact_ grants rather than inventing them — a role an admin narrowed stays
  narrow, and a role with no contact grants gets nothing.
- **Four modules gained `linkLabels`.** Resolving a polymorphic target has to
  be done by the module that owns the record (ADR-0001), applying its own
  scope and field rules; the activities module asks, it does not query. The
  lookup is batched, so a page of activities costs at most four queries.
- **`OutboxService.publish` gained `availableAt`.** One optional field turns
  the outbox into a scheduler (ADR-0025). Existing callers are unchanged.
- **The worker gained an email provider and three handlers** — assignment,
  reminder, digest — plus `pruneActivityLinks`. The `EmailProvider` interface
  moved to `@crm/core` so the API and the worker share one declaration.
- **`notifications` gained `digested_at` and `source_event_id`**, both
  nullable, and `record_views` is new.

Decisions recorded rather than fixed:

- **The bell polls rather than subscribes.** One indexed count a minute until
  there is something to subscribe to; websockets are Phase 2.
- **A reminder that is moved leaves its old outbox row behind.** It is claimed
  once, checked against the activity and discarded (ADR-0025). The cost is
  rows; the alternative is a service reaching into the relay's table.
- **`activities.body` is not searchable.** Free-text search is over the
  subject: matching inside markup is both wrong and slow, and body search
  belongs to the search provider in M7, which will index extracted text.
- **Recently-viewed is written by the client.** A GET that writes would make
  every record page a write transaction and rule out a read replica later. The
  server still checks the caller may read what they claim to have opened.

## Global search and the command palette (MVP_SPEC M7), reviewed

The first read path that **deliberately crosses every object**, and the first
that answers a question about records the caller has not named. Every other
read starts from an id the caller already holds; this one starts from a string
they typed and looks in five tables. That makes it the easiest place in the
product to leak from, and it is why this section is longer than the feature.
The design is in [ADR-0028](adr/0028-global-search-index.md).

| Question                                                     | Answer, and where it is proved                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Can a search return another tenant's record?                 | No. RLS applies to `search_documents` like every other tenant table, and the tenant is additionally a predicate in the query. Tenant B holds a contact with the same name, the same phone number and a distinctive address; none of it is reachable from tenant A on any field, and the answer for B's exact address is byte-identical to the answer for one nobody holds. 4 tests                                                               |
| …or a colleague's record outside the caller's scope?         | No. Each object type's `own`/`team`/`all` constraint is a `WHERE` clause against an `owner_id` copied onto each index row — not a filter on fetched rows, which would also quietly break the result count. A rep searching a word the admin and the rep both hold gets only their own, across contacts, deals **and** activities. 3 tests                                                                                                        |
| Is scope applied **per object type**?                        | Yes, and it has to be: a role with `all` on contacts and `own` on deals is the ordinary shape of a manager. One predicate for the whole query would be wrong for one of them, and the wrong one is the one that leaks. "applies scope per object type, not once for the whole query"                                                                                                                                                             |
| Can a hidden field be searched?                              | No. The index holds **one row per (record, field)**, and the query carries `field_key in (…)` built from `readableFieldKeys`. A role with `contact.email` hidden cannot find a contact by its address — not even one they own — while an admin can. That shape is the reason for the row count (ADR-0028 §1). 2 tests                                                                                                                            |
| Can a record be returned _because_ a hidden value matched?   | No, and that is a separate question: returning the record without the value would still answer "is this address in this workspace", one guess at a time. A contact that matches only on its hidden address is absent entirely, and the response for that word is empty. "does not return a record that matched only on a hidden field"                                                                                                           |
| Can a hidden field appear in the snippet?                    | No. The snippet is the matched row's own `value`, and the match could only have been on a readable field — so the classic search leak, where the column is stripped from the payload but its text appears in the surrounding excerpt, has nowhere to happen. A record matching on a readable name while holding a hidden address quotes the name; the address is absent from the whole response body. "never quotes a hidden field in a snippet" |
| Is a field permission per object, or per name?               | Per object. `email` hidden on contacts leaves `email` on leads matchable and quotable, which is what an administrator configured. "hides a field on one object type without hiding it on another"                                                                                                                                                                                                                                                |
| What does an actor with no readable searchable fields get?   | Nothing from that object type, and the object type is **not in the query** rather than filtered out of its results. A role that may read deals but not `deal.name` — its only searchable field — gets an empty list. "searches no object at all when every searchable field on it is hidden"                                                                                                                                                     |
| Is a soft-deleted record findable?                           | No. The projection skips deleted rows, so the delete event removes its index entries; and even before the relay catches up the live re-resolve drops it. Both halves are asserted, before and after reindexing. `search.spec.ts` "forgets a record once it is deleted and the index catches up"                                                                                                                                                  |
| The index holds a **copy** of the owner. What about the gap? | A record reassigned out of a rep's scope stops being returned immediately, while its index rows still say otherwise: every hit is re-resolved through the owning module's service before it is serialised (ADR-0028 §5). The test deliberately does not reindex. "drops a record reassigned out of scope before the index catches up"                                                                                                            |
| Does a caller with no permissions learn anything?            | No. They get `200 []`, not a 403. A 403 would be the one answer that distinguishes "you may read nothing" from "there is nothing here", and neither is worth telling them. "answers a caller with no grants with an empty list, not a 403"                                                                                                                                                                                                       |
| Can a query string reach the query language?                 | No. `searchTerms` in `@crm/core` reduces the input to bare `[\p{L}\p{N}]+` words before anything is built, so no `&`, `\|`, `!`, `:`, `*` or quote survives to `to_tsquery`; the terms then travel as one bound parameter. It is a pure function with its own tests, including six hostile strings. `packages/core/src/search/search.spec.ts`                                                                                                    |
| Can the index be written through a request?                  | No. `crm_app` has `SELECT` on `search_documents` and nothing else; `crm_worker` writes it. A flaw in a request path cannot poison what other people find                                                                                                                                                                                                                                                                                         |
| Can an event index a record in another tenant?               | No. The relay opens a transaction scoped to the event's tenant, so an id from elsewhere does not resolve and nothing is written — in either tenant. `apps/worker/src/handlers/search.spec.ts` "stays inside the event tenant"                                                                                                                                                                                                                    |

The four mandatory suites from CLAUDE.md §10 are in
`apps/api/src/modules/search/search.security.spec.ts` (20 tests): tenant A
cannot find tenant B's records on any field and cannot point `X-Tenant-Id` at
them; a rep with `own` scope finds only their own contacts, deals and
activities; a hidden field is neither matched on nor quoted, and an object
whose searchable fields are all hidden is not searched; and unauthenticated
requests get 401.

### The one deliberate weakening: two operators marked `LEAKPROOF`

`search_documents` has RLS like every tenant table, and a table with RLS is a
**security barrier**: Postgres will not evaluate a qual that is not marked
`LEAKPROOF` before the policy has filtered the rows, so such a qual can never
become an index condition. Neither `tsvector @@ tsquery` nor pg_trgm's `<%` is
leakproof in core, so the planner was reduced to a sequential scan of the whole
table — 70 ms where the same query outside RLS took 4 ms, and growing with the
table. No index shape fixes it; the rule is about the operator.

`packages/db/sql/bootstrap/01-extensions-and-roles.sql` therefore marks exactly
two functions leakproof: `ts_match_vq(tsvector, tsquery)` and
`word_similarity_op(text, text)`.

This does **not** weaken row security. The policy still filters every row; the
marking only lets the planner apply the match earlier, which is where the index
is, and a leakproof qual is still applied to rows the policy allows. The
isolation suite is unchanged and still passes. The barrier exists to stop a
_caller-supplied_ qual from seeing rows before the policy does, and no caller
here can supply a qual: every predicate on every table is built in application
code from a closed set of whitelisted fields and operators (§5.7). Both
operators return a boolean and have no data-dependent error path.

It is recorded here rather than left in a SQL comment because it is a change to
a Postgres safety default in a multi-tenant system, and because anybody
reviewing isolation should meet it. The reasoning is in full in ADR-0028 §7,
and `search.perf.spec.ts` fails if either marking is removed.

### What building search changed

- **`constraintToSql` moved from `apps/api/src/common` to `@crm/db`.** The
  Postgres search provider needs the identical translation and lives outside
  the API; a second copy of that particular rule is exactly what the comment on
  the original warned about. The API file re-exports it, so no module's import
  changed.
- **`ActivitiesService` gained `linkLabels`.** Activities are not link targets
  (ADR-0005 keeps that set to the four record types), so this exists for search
  alone — resolving a hit through the module that owns it, with that module's
  scope and field rules.
- **The worker test suites no longer run in parallel.** The relay claims
  `outbox_events` across every tenant, so two suites each driving a relay steal
  each other's events: the other file's relay claims the row, finds no handler
  for that type, and marks it relayed. That is the production design working,
  not a flake, and `fileParallelism: false` says so.
- **`pnpm db:seed` now indexes what it inserts**, as `crm_worker`, because the
  seed writes records directly and so emits no events. Without it the demo
  tenant would have an empty palette.

### Decisions recorded rather than fixed

- **The index is eventually consistent.** A record is findable a moment after
  it is saved. The re-resolve (ADR-0028 §5) makes that a freshness property
  rather than a security one, but a snippet can lag by the relay interval.
- **`activities.body` is not searchable**, as the M6 review already promised:
  matching inside sanitized markup is both wrong and slow, and a note is the
  likeliest place for something a colleague should not stumble over (ADR-0024).
- **Custom fields are not searchable.** They are per tenant, so indexing them
  means the index schema stops being fixed; ADR-0028 §6 says what that costs.
- **There is no backfill for records that predate the index.** The same
  situation migrations 0008–0010 had with grants: the migration role is subject
  to the same forced row security as everyone else. `reindexTenant` in
  `@crm/db` is the building block a deployment's one-off script would call; no
  tenant exists outside development, where re-seeding is the fix.
- **A very common term still costs what it costs.** GIN lookup cost is
  proportional to matches, not to table size, so a word held by a large
  fraction of a tenant's rows has to be ranked in full before the top ten is
  known. ADR-0028 §8 lists that and the other four things that break the
  budget.

## Import and export (MVP_SPEC M8), reviewed

This module closes two §5 rules that had nothing to protect until now (11 and 12),
and it is the one path that creates records in bulk from a file a user supplies,
so the review asks what an import can do that a normal write cannot. The design
is in [ADR-0029](adr/0029-import-export-pipeline.md) (the pipeline) and
[ADR-0030](adr/0030-file-handling-and-spreadsheet-safety.md) (files and
spreadsheets).

| Question                                                         | Answer, and where it is proved                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a column set `owner_id`, `tenant_id`, `version`, an id?      | No. Not in `IMPORTABLE_SYSTEM_KEYS` (an allowlist), refused by the mapping check at `start` and at **every chunk**, and by a row-level guard even if both are bypassed (`import.security.spec.ts`, `imports.security.spec.ts`).                |
| Can it write a field the actor cannot?                           | No. Mapping offers only `canWriteField` fields; each row's supplied value is checked again; a hidden and a read-only and a non-existent field produce byte-identical errors. A field revoked mid-import stops the job.                         |
| Can it reassign or read a colleague's records?                   | No. Every imported record is owned by the importer. Duplicate matching sees only the actor's read scope, so `update` cannot touch a colleague's record and `skip` cannot reveal one. Tested for `own` and `team`.                              |
| Does a retry double-create?                                      | No. The chunk, its checkpoint and the next step commit as one transaction; a redelivered or crashed-and-retried chunk is a no-op or a clean redo (`import.pipeline.spec.ts`; `counts_add_up` CHECK in the database).                           |
| Is permission judged when the import runs, or when it was asked? | When it runs: the actor is rebuilt from the database per chunk. Losing `import`, `create`, `update`, a field write, or membership mid-run fails the job. Same for `export` at run time and at link time.                                       |
| Can a small file exhaust the worker?                             | No: size, inflated bytes (counted), ratio, entry count, rows, columns, cell length and parse time all have ceilings (ADR-0030 §6); a 220 MB bomb is rejected in seconds; a cell at column XFD is rejected.                                     |
| Can the file be swapped after it is checked?                     | No. The presigned URL outlives analysis, so analysis **and** staging each fully validate; a test swaps the object between them.                                                                                                                |
| Can the API be used to read or serve a file?                     | No. No endpoint accepts a file, none returns bytes, the API has no read path to storage (counted), and neither storage key is ever returned.                                                                                                   |
| Can one user see another's import or export?                     | No. Lookups are by creator as well as id (404 across users, across tenants, and for an Admin); RLS is on all four tables; the API role has no grant on staged rows or error rows.                                                              |
| Does export leak a hidden field or another scope's rows?         | No. A hidden field has no column; the scope is a `WHERE`; filtering or sorting on a hidden field is refused identically to a non-existent one. `exports.parity.security.spec.ts` shows the export returns the list's rows in the list's order. |

Four mandatory suites (§10): tenant isolation (jobs, staged rows, matching,
records), `own`/`team` scope, hidden/read-only fields on mapping, per-row write
and export columns, and 401 on every endpoint — in `imports.security.spec.ts`,
`exports.security.spec.ts`, `import.security.spec.ts`, `export.security.spec.ts`.

**What this review changed.** A deadlock in the first design of "mark the job
failed on the last attempt" (the job row is locked by the attempt's own
transaction) found by a test and fixed with a relay-level `onExhausted` hook;
an XLSX compatibility bug (the streaming reader assumed an entry order that
writers do not agree on) found by looping a read forty times and fixed by
re-ordering the validated archive; the finding that **field write access derives
from the `update` grant, not `create`**, so a create-only role can import nothing;
and the finding below about `team` scope.

**Gaps, deliberately:**

- **`team` scope reads but cannot update a teammate's record**, in the API and
  therefore in an import. `satisfiesConstraint` resolves team scope through
  `record.teamId`, which no service passes. Pre-existing and not fixed here;
  `import.security.spec.ts` documents it so a fix shows up as a changed test.
- **Export filter SQL is a copy** of the four modules' list SQL (`planQuery` in
  `@crm/db`), guarded by a parity test rather than shared. Lifting the originals
  into one implementation is a follow-up.
- **The relay delivers events one at a time**, so the 49,000 side effects of a
  50,000-row import (search, timeline) take much longer to drain than the import
  takes to finish. Not a security issue; a throughput one (ADR-0029).
- **Deals are exported, not imported**, pending a rule for naming a stage in a
  spreadsheet. **Malware scanning and eager deletion of expired files** are not
  built. Record attachments now exist and reuse this path (below).
- **`exceljs` carries deprecated transitive dependencies**; the parser is isolated
  in `apps/worker/src/import-export/parse.ts`.
- **No eager sweep of expired export files**; the API refuses their links and the
  bucket's lifecycle rule removes them.

## Users, roles, field permissions and the access explainer (MVP_SPEC M3), reviewed

This module edits the permission configuration that every other rule in this
document depends on, and adds a read path **across people** (the explainer). Both
are held to the four mandatory suites in `access.security.spec.ts` (27 tests), and
the explainer to a fifth property, in `explainer.parity.security.spec.ts` (19):
**what it says must equal what the HTTP API does** — see ADR-0033.

| Question                                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the explainer disagree with the API?           | It is built so that it cannot, and a test tries. `can()` returns its own reasoning (`derivation`) from the same pass that decides; the explainer only translates it. For every record, of five object types, and every member, the parity suite asks the explainer, then asks the real API as that member: can they open it (200 vs 404), is the list the same set, is each field present or absent, is the record count the list length. A mutation check — reverting the team-scope fix — was confirmed to fail it |
| Who may use it?                                    | Administrators only, by `can()` (`role:read` + `membership:read`, administrative objects at `all` scope). A rep and a manager get 403 on **all 21** routes, and the explainer routes say nothing about colleagues, roles or hidden fields                                                                                                                                                                                                                                                                            |
| Can it be used to probe whether an id exists?      | No. The collection-level grant is checked before the record is loaded, so a rep gets the same 403 for a real record and a made-up one. For an administrator whose own reach is `own`, a record outside it is a 404 byte-identical to a missing id                                                                                                                                                                                                                                                                    |
| Can it be used to enumerate members?               | Not by anyone who may not already list them. Reassignment settles everything that depends on the _actor_ before it looks up the person they named; otherwise "unknown member" (422) versus "forbidden" would tell a caller which ids are members. A test names a real member and an invented one and requires identical responses                                                                                                                                                                                    |
| Does it cross tenants?                             | No. People come from `memberships` under RLS, records from RLS-scoped tables. B’s role, member, team and record each answer 404 from A (never 403), and B’s ids cannot be put into A’s configuration (a foreign role, parent team, team member or copy source is a 422/404)                                                                                                                                                                                                                                          |
| Does it reveal fields hidden from the viewer?      | No: a field the viewer cannot read is not listed, and no person’s access to it is described. Tested with a viewer whose role hides `phone`, against a control viewer who sees it                                                                                                                                                                                                                                                                                                                                     |
| Does it reveal how much data exists?               | Counts (in the preview, the explorer and the reassignment dry run) are returned only for an object the viewer can `read` at `all` scope; otherwise `null`. Tested with an `own`-scope viewer                                                                                                                                                                                                                                                                                                                         |
| Can somebody who edits roles give themselves more? | No. `grantsBeyond` asks `can()` whether the editor’s own reach covers each grant a patch adds, a copy copies, or a role assigned to somebody carries (`PERMISSION_ESCALATION`). Held for a custom role with `role:update` and only `team` scope; the preview flags it before they try to save                                                                                                                                                                                                                        |
| Can the workspace be locked out?                   | No. After a change is written and before it commits, the engine is asked whether anybody can still manage roles and members; if not, the transaction rolls back (`LAST_ADMINISTRATOR`). Covers editing the role, demoting or suspending the last administrator, and suspending oneself. The preview reports it beforehand                                                                                                                                                                                            |
| Can what was previewed differ from what is saved?  | No. Preview and save share `applyPermissionPatch`; a save carries the digest of the state previewed and is refused (409) if the role has since changed, with the role row locked across the check and the write                                                                                                                                                                                                                                                                                                      |
| Are permission changes applied immediately?        | Yes. The actor is rebuilt from the database on every request, so a role edit, a role change and a suspension each take effect on the person’s next request — tested for all three                                                                                                                                                                                                                                                                                                                                    |
| Can a grant be made that nothing consults?         | No. `GRANT_CATALOGUE` says which (object, action, scope) combinations mean something (no `import` on deals, no `own` scope on an administrative object); a patch that _adds_ one outside it is a 422. Legacy rows outside it can still be removed                                                                                                                                                                                                                                                                    |

### What building it changed

- **A real bug in team scope.** Lists resolved `team` scope in SQL ("owned by me or
  by anyone on my teams"), but the record-level `can()` call every service makes
  was given only `ownerId`, so a teammate’s record was in the list and a **404 when
  opened** — in the API and in imports. Found by the parity suite as soon as it
  had a manager and a teammate in it. The services now pass the owner’s teams
  (`recordRefFor` in `@crm/db`). **This widens what a team-scope user can open and
  edit**, to what the list already showed. One worker test that recorded the old
  behaviour as a known gap was updated.
- **`role`, `team` and `membership` are objects in the permission model**, granted to
  Owner and Admin by `provisionTenantDefaults` and backfilled for existing tenants by
  migration 0013 (system Owner/Admin only; a custom role gets nothing).
- **`loadActor` is now `loadActors` for one user.** The explainer needs every
  member’s actor, built the way a request builds it, and two copies of that query
  would be two definitions of "who may".
- **Four modules gained a one-line registration** (`OwnershipRegistry`) so
  reassignment can write to their tables without the access module knowing their
  schema; activities also re-announce the assignment and reminder, as an edit does.

### Known gaps, deliberately

- "Who can see this" explains `read`. Update and delete are visible per object in
  the reach view, not per record.
- A person holds one role. The engine and explainer handle several; nothing here
  is tested with two.
- Team **membership** changes are audited but not previewed.
- Team hierarchy is kept acyclic but does not widen reach.
- Support impersonation (P1) is not built.
- Counts are exact `count(*)`s: fine to a few hundred thousand rows per object, and
  the first place to need a timeout and an estimate at 1M.

## Record attachments (MVP_SPEC §6.1), reviewed

Attachments are the second user of the file path row 12 describes, and the
first one where the file is supplied by one person and downloaded by another.
The review therefore asks what an attachment can do that neither a record nor
an import can. The design is in
[ADR-0035](adr/0035-record-attachments.md).

| Question                                                 | Answer, and where it is proved                                                                                                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the polymorphic pair reach around record scope?     | No. Every path resolves `(object_type, record_id)` through the module that owns it, for the action being attempted, with that action's constraint applied in SQL. A foreign record and an id nobody issued produce **byte-identical** 404s.               |
| Can reading a record become permission to change it?     | No. `read` lists and downloads; `update` attaches and deletes. A read-only user can do the first two and neither of the last two, on a record they can see.                                                                                               |
| Can a client choose the content type?                    | No. The contract has no `mime` field (an extra key is a 422); the server maps the allow-listed extension to its own canonical type, binds that into the presigned PUT, and serves the download as it.                                                     |
| Can an uploaded file be rendered rather than saved?      | No. `svg`, `html` and `xml` are not on the allow-list at all, and every download is `Content-Disposition: attachment` built by one function both storage providers call. Asserted on the header a download would actually carry.                          |
| Can the filename break the header, or disguise the file? | No. Separators, `..`, control characters, bidi overrides and a 300-character name are **refused** with a reason; `safeDownloadName` reduces whatever survives to `[A-Za-z0-9._-]`, ≤120 characters, before the header. Both passes are tested separately. |
| Can the bytes be something other than the name says?     | No. The worker reads the first 8 KB, detects the format from the shared signature table and compares it with the claim; a mismatch is rejected and the object deleted. Twelve pairings tested, including an executable named `.pdf`.                      |
| Can the file be swapped after it is confirmed?           | No. The worker re-checks `head()` and reads the object **as it is then**, not as it was declared. A test swaps a PDF for a PE executable between the two.                                                                                                 |
| Can the API be used to read or serve a file?             | No. No endpoint accepts a file body, none returns bytes, and a whole create–confirm–download–delete flow leaves the provider's read and write counters untouched.                                                                                         |
| Is a storage key ever guessable, or ever returned?       | No. 256 random bits under `tenants/<id>/attachments/`, never derived from the filename, absent from every response and from the audit log. Five creates produce five distinct keys.                                                                       |
| Do presigned URLs expire?                                | Yes: 10 minutes to upload, 5 to download, asserted against the issued expiry and then by stepping the clock past it and watching the store refuse.                                                                                                        |
| What happens to the bytes when the row goes?             | A delete is soft and schedules `attachment.purge_due.v1` 30 days out; the worker then removes the object and the row, bytes first. A restored attachment makes the pending event a no-op.                                                                 |
| What happens when the record the file hangs from goes?   | While it is soft-deleted, nothing — it can come back. Once it is really gone, `pruneAttachments` removes the objects **and** the rows: an orphaned row is untidy, an orphaned private file is worse.                                                      |

Four mandatory suites (§10): tenant isolation on every endpoint, `own` scope
against another rep's record, permission separation between read and update,
and 401 on all five routes — in `attachments.security.spec.ts`, with the byte
check and both cleanup handlers in `apps/worker/src/handlers/attachments.spec.ts`
and the policy itself in `packages/core/src/files/attachments.spec.ts`.

**What building attachments changed.** The signature table and the "plausibly
text" test moved out of `magic-bytes.ts` into `files/signatures.ts`, so import
and attachments now read one table with two allow-lists rather than two tables;
`magic-bytes.ts`'s own tests passed unchanged, which is what made the move safe.
`safeDownloadName` moved out of the S3 adapter so the in-memory provider applies
the same sanitiser — before this, the test suite was asserting a fake's idea of
the control. Five services gained a generic `allowsRecordAction`.

**Gaps, deliberately:**

- **No malware scanning** (P1, MVP_SPEC §8). The seam is the worker's byte check.
- **No undelete**, although the bytes and the row survive 30 days precisely so
  that one can exist. Until it does, the retention window is a cost with no
  feature behind it (ADR-0035 §7).
- **For `zip`, `docx`, `xlsx` and `pptx` the byte check establishes "a zip
  archive" and nothing more.** We never open an attachment archive, so a bomb
  inside one costs storage and nothing else — `inspectXlsxArchive` is not in
  this path.
- **`AttachmentTargetsService` duplicates the activities module's
  `RecordLinksService`** in shape. Consolidate when a third polymorphic feature
  lands, not before (ADR-0035).
- **No inline preview** of an image or a PDF. That is the one feature that would
  need something other than `Content-Disposition: attachment`, and it would need
  a separate origin and its own ADR.

## Audit viewer, Recycle Bin and data rights (MVP_SPEC M4, M11), reviewed

Three features, one of which forced a decision that had to be written down
rather than made in passing.

### The decision: erasure against an append-only log (ADR-0032)

CLAUDE.md §5.10 makes the audit log append-only by **withholding** `UPDATE` and
`DELETE` from `crm_app`, not by policy. DPDP §12 and GDPR Art. 17 require
personal values to stop being readable, and MVP_SPEC M11 says the audit row is
kept with values replaced by `[erased]`. That is an `UPDATE` on a table whose
whole integrity story is that nothing can perform one.

The honest answer is that erasure needs a separate privileged path, and
[ADR-0032](adr/0032-erasure-against-an-append-only-audit-log.md) builds it as
narrowly as Postgres allows:

- a fifth role, **`crm_erasure`**, whose credentials the API never holds — only
  the worker's erasure handler connects as it;
- `GRANT UPDATE (changes)`, a **column** grant, so `action`, `actor_id`,
  `occurred_at`, `object_type`, `record_id` and `ip_address` are beyond its
  reach: who did what, to which record, when and from where survives any
  erasure;
- no `INSERT` and no `DELETE`, so it can neither fabricate nor remove history;
- a **policy** admitting a row only while an `erasure_requests` row for that
  exact subject says `processing` — a window the worker opens and closes as
  `crm_worker`. Outside it the role sees zero rows;
- nothing at all on `contacts`, `leads`, `deals` or `users`.

`packages/db/src/erasure.security.spec.ts` asserts every one of those against a
real Postgres, including that `crm_app` and `crm_worker` are both refused
outright. The residual — a compromised worker could blank one subject's diffs in
one tenant during an erasure it already controls — is stated in the ADR rather
than papered over.

### The hard part: field permissions over a diff

MVP_SPEC M3 requires a hidden field to be absent from "API responses, exports,
search results **or audit diffs** shown to that role". An audit diff is the read
path where that is easiest to miss: the field is stripped from the record
everywhere, and its value quietly survives in the history of the change that set
it.

`visibleAuditChanges` in `@crm/core` is the only route from `audit_logs.changes`
to a response or a file, and it calls the same `canReadField` as
`contacts.serializer.ts`. Three rules, each tested directly:

1. a top-level key is kept only if the actor may read the field it names —
   converted camelCase→snake_case, because a _mapping_ with a missing entry fails
   open while a conversion cannot;
2. `customFields`, which `diffChanges` records as one blob holding every custom
   value, is **split per key** and each key checked on its own, so a hidden
   custom field cannot ride along inside a visible entry;
3. a row about an object type the reader has no `read` grant on yields nothing —
   reading history does not recover access a role was deliberately not given.

It lives in `@crm/core` rather than in the API because the worker writes the
exported copy of the same log, and the file and the screen must agree. The
export test asserts the same hidden value is absent from the file.

`withheldFields` is reported rather than the diff silently shrinking: an audit
log that shows a reader less than happened, without saying so, is the worst
failure mode an audit log has.

### The constraints the task set, and where each is proved

| Constraint                                                      | Where                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tenant A's administrator cannot see tenant B's audit rows       | `audit-log.security.spec.ts` "tenant isolation", both directions     |
| A non-administrator cannot reach the viewer at all              | same file: Sales Rep, Manager, Read-only, and a narrower-scope grant |
| The Recycle Bin does not list records outside the actor's scope | `recycle-bin.security.spec.ts` "record scope"                        |
| The tenant export contains only that tenant's data              | `archive.security.spec.ts`, against a neighbour with similar data    |
| The four mandatory §10 suites, per module                       | each module's `*.security.spec.ts`                                   |

### What building these changed

- **Three capabilities became object types** — `audit_log`, `tenant_data`,
  `data_subject` — so reaching any of them is a row in `role_permissions`, not an
  `if (role === 'Owner')`. Kept apart rather than folded into one `data_rights`
  type because a whole-workspace archive, one person's file and an irreversible
  erasure are not the same decision; one type would make granting the mildest
  grant the most dangerous one.
- **The audit viewer requires `all` scope.** `own` and `team` have no meaning on
  a log, and a half-working scope is worse than a refusal that says why
  (ADR-0034 §3).
- **Every audit query is bounded in time**, defaulting to 30 days, because
  `occurred_at` is the partition key. `audit-query.perf.spec.ts` asserts a bounded
  window opens at most two partitions and an unbounded one opens many — the
  negative case included, so the default stays load-bearing.
- **Restore re-checks permission at restore time** and carries a `version`. It
  does not inherit the right from whoever deleted the record; a rep whose
  ownership moved cannot pull a record back into view.
- **The purge schedules itself** as one outbox row per tenant, with a partial
  unique index guaranteeing exactly one pending sweep, and cleans up polymorphic
  links, tags, timeline rows, recently-viewed entries and stale index rows in the
  same transaction as the record (ADR-0034 §6–7).
- **The erasure's own audit entry carries counts, not values.** Recording what
  was erased would make that row the last place the erased data lives.

### Verified in a browser

`apps/web/e2e/governance.spec.ts` (5 tests) passes against the real stack —
isolated database, MinIO, API, worker and a production `next start` — alongside
the 82 existing E2E tests (87 in all). It covers the rep's no-permission state,
delete → Recycle Bin → restore → back in the list, the Owner's workspace archive
and the rep's refusal, and an erasure driven from the browser that leaves the
address visible in the audit log before and `[erased]` after.

It found two defects that no unit test could have: the UI read `mutation.error`
inside its own `catch`, which is the previous render's value, so a 403 never
switched a card to its no-permission state; and the erasure list never refreshed
while the worker was still carrying the request out.

### Deliberately out of scope, and said so

- Redaction reaches the subject's **own** audit rows. Rows about related
  records — an activity mentioning the person, a deal named after them — are not
  scanned for values; widening that has a real cost and belongs in its own ADR.
- Whole-tenant and one-person archives are JSON only. CSV is refused with a 422
  rather than producing a file that silently loses the structure.
- The Recycle Bin has no "delete permanently now" action. The retention job is
  the only hard-delete path for records, which keeps one place to reason about.

## Company setup and sample data (MVP_SPEC M2, ADR-0037), reviewed

This module lets an administrator edit their own company and add or remove sample
records, so it is the first thing that writes to `tenants` from a request and the
first that deletes many records in one action. Both are reviewed here against §5.

| Question                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could the app already rewrite its own tenant row?          | **Yes, before this module.** Migration 0004 gave `crm_app` and `crm_worker` table-wide `UPDATE` on `tenants`; RLS limited the row, not the column, so a bug in any request path could have set `plan`, `status`, `slug` or `region`. No endpoint wrote the table, so nothing did. Migration 0017 withdraws it: `crm_app` keeps `UPDATE` on six profile columns, the worker keeps only `SELECT`. `onboarding.security.spec.ts` proves it, and fails exactly those seven tests with the migration's narrowing removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Can a request name a tenant, plan, status, slug or region? | No. Every body is `.strict()`, so such a key is a 422; and the database would refuse the write anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Who may use it?                                            | `tenant_settings` (read, update), Owner and Admin by default, grantable to a custom role. Loading sample data additionally requires `create` on every kind it creates, and removing it requires `delete` on every kind: a role holding only some cannot load a partial company. A rep or a manager learns nothing from the refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Can one company see or remove another's sample data?       | No. `sample_records` has RLS and its own isolation tests; removal runs in the worker under the event's tenant, and is tested to leave a second company's records, registry and search entries untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Can removal delete something a person made?                | It is built not to, and this is the riskiest part, because **nearly every reference to these tables is `ON DELETE SET NULL` or `CASCADE`**: a reference it failed to notice would not fail the delete, it would silently null a column or drop a link on a record somebody owns. So the rule is a closure over every reference (edited, referred to by a non-sample record, or referred to by a kept record), and **each reference has its own test that asserts the referrer's pointer survived**. Both layers were mutation-tested: every removal rule and reference check was disabled in turn (ten mutations, and the closure edges from a kept deal again after the first run showed redundant sample data was hiding them), and so was every API permission check, the strict body and the status shape (ten more). Each was caught by the tests that should catch it. A first version of the harness counted "did not run" as "caught" and reported ten out of ten while nothing had run; it was fixed to report that as an error, and rerun. |
| Is there a race between the decision and the delete?       | The mark that precedes the purge carries `version = 1`, so a record edited in between is not marked and not deleted, and the cleanup of what points at it runs only for marked ids. The window itself is not exercised by a test, because it needs two transactions interleaved mid-statement; the guard is by construction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Why does removal run in the worker?                        | It clears the search and timeline projections, which the application role cannot write by design (migration 0011). A test shows the app role is refused if it tries. The worker re-checks the requester's `tenant_settings:update` when it runs, so rights withdrawn between the click and the job stop the deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Does loading notify anybody or create work for others?     | No. Tasks get no reminder and no `activity.assigned.v1`. Everything else a real creation emits (audit row, `created` event) is written in the same transaction, so sample data is searchable and on timelines, and a test through the real relay proves it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Can loading leave half a company behind?                   | No: one transaction, serialised per tenant by an advisory lock. Tested with a failure after loading, and with two simultaneous loads (exactly one succeeds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| What does the status reveal?                               | Booleans and counts to someone holding `tenant_settings:read`, never a record's content or an id. "Is there a deal" is a company-level fact, not a record, and is shown to administrators regardless of their record scope; that is a deliberate choice and is tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Is it audited?                                             | Profile edits (old and new, only what changed), setup completion, and sample data being loaded and removed (`sample_data_loaded`, `sample_data_removed`, plus a `create` or `purge` row per record).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Known gaps, deliberately

- **A new foreign key to the five record types has no guard.** The Recycle Bin's
  `POLYMORPHIC_REFERENCE_TABLE_LIST` meta test catches a new polymorphic table, but
  nothing fails if someone adds a real foreign key that removal does not know about,
  and `SET NULL` would hide it. Adding one means adding an edge to `removal.ts` and a
  test (ADR-0037).
- **Edit detection is `version > 1`.** An edit that does not bump `version` reads as
  untouched. Writes through the API do bump it.
- **If the worker is down, a removal stays "removing" indefinitely.** The screen
  shows it truthfully and the request is not lost; there is no timeout or retry
  prompt in the UI.
- **The "(sample)" mark is English and lives in the data**, not in the i18n layer.
- **"Customize pipeline" is not on the checklist** until the customization UI (M9)
  exists to complete it.
- **The "first deal in ten minutes" acceptance criterion needs people** and has not
  been verified; the end-to-end suite measures the click path, not the time.

## The dashboard (MVP_SPEC M10, ADR-0038), reviewed

Every figure on the dashboard is a sum or a count over other modules' records, which
is the quietest way to read a field that was hidden or a record that was out of scope.
It is reviewed here against §5 with that in mind.

| Question                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is each widget authorized?                               | Yes, one at a time, by `can()` against the object it summarises (`deal`, `lead`, `activity`). A role with `lead` and no `deal` gets 403 on the pipeline, the won figure and the leaderboard and a working leads card. There is no `dashboard` grant, so there is no second opinion about the same records. Tested for a role with some grants, one with none, and one with mixed scopes.    |
| Can a total reveal a record outside the reader's scope?  | No. The scope is a `WHERE` clause in each module's own repository query (the one its list uses), not a filter on the result. Tested per widget: a rep with `own` scope gets the figures of their own deals, wins, leads and tasks, and the same pipeline numbers the board gives them.                                                                                                      |
| Can a total reveal a hidden field?                       | Not when the figure is built from it. `amount` hidden → counts, no money (and no currency of any deal); `closed_at` hidden → no won figure; `owner_id` hidden → no leaderboard; `stage_id` hidden → no pipeline; `status`, `source`, `type`, `due_at` likewise. Each is `null` in the response, never zero, and has its own test that also scans the whole payload for the hidden values.   |
| What is still shown to someone who cannot read `amount`? | Counts that do not depend on it (deals in a stage, wins this month), as the board always did, and the company's reporting currency, which is a fact about the company and not about any deal.                                                                                                                                                                                               |
| Do names leak?                                           | The leaderboard names people through `MemberDirectory`, which returns display names of **active members**, for the ids it is given, and nothing else (no address, role, status, list or search). The ids come from deals inside the reader's scope. Tested: no address in the payload, a rep sees only themselves, a suspended member is labelled neutrally and their name does not appear. |
| Does the client choose the tenant, user or owner?        | No. The only query parameter is `pipelineId`, and the schema is `.strict()`: `tenantId`, `userId`, `ownerId` and `amount` are 422. A tenant named in a header is ignored. A pipeline of another company is 404 with the same body as one that does not exist.                                                                                                                               |
| Is there SQL built from input?                           | No string building. The time zone is a bound parameter after an IANA check, ids are bound, and the sources are grouped by an expression of the column, not of anything sent.                                                                                                                                                                                                                |
| Is "this month" trustworthy?                             | The boundaries are computed in SQL from the database clock and the company's zone, once per request, and passed to the query as instants. Tested for four zones (including a +14:00 one and a DST one) against `Intl`, independently of the SQL. Fixtures sit an hour or more from every boundary, so a skewed container clock cannot move one.                                             |
| Is money correct?                                        | Per-currency subtotals are converted once; a currency with no rate is counted, left out of the total and named; a leaderboard row built on one is flagged `partial`. The month-on-month change is integer arithmetic.                                                                                                                                                                       |
| Does it cost too much on a large company?                | "Won this month" has its own partial index (migration 0018) and a plan test that asserts it is read and that the rows read are about the window, not the company's history. Open pipeline and open leads read every open record of the company, as the board does; that is recorded as a known limit in ADR-0038 with the remedy.                                                           |
| Is it audited?                                           | It writes nothing, so there is nothing to audit; reads of other lists are not audited either.                                                                                                                                                                                                                                                                                               |

The guards were mutation-tested: each field gate, each `can()` check, each scope clause
and each rule (deleted, converted, wrong stage, window bounds, time zone, ordering, the
top-ten cut, `partial`, former members) was disabled in turn and the dashboard specs had
to fail.

### Known gaps, deliberately

- **Open pipeline and open leads are computed per request over every open record.**
  Fine to the tens of thousands; a million open leads wants a maintained count or a short
  cache (ADR-0038).
- **The index is built inside the migration transaction.** Safe while `deals` is small;
  on a large live table it belongs outside the runner (the note in 0007 and the recipe in
  0016 apply).
- **A custom role has to be given six more fields to see the whole page** (`closed_at`,
  `owner_id`, `stage_id`, `type`, `due_at`, `status`). A role missing one sees that figure
  as "not available to you", which is the safe direction to be wrong in.
- **The leaderboard shows display names to a reader who could not list members.** Narrow
  and tested not to widen, but a disclosure.
- **No customisable layout, saved views or scheduled reports** (MVP_SPEC P1).

## Customization (MVP_SPEC M9, ADR-0039), reviewed

A custom field definition decides what every record in a company looks like, so this
module is reviewed for what it can break afterwards, not only for who may call it.

| Question                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may change a definition?                                 | `update` on `tenant_settings`, checked by `can()` in the service for create, edit and order. A rep, a read-only user and a role holding only `tenant_settings:read` are each refused every write, and a test proves nothing changed. Reading the list needs `read` on the object.                                                                                                                                                                   |
| Can one company see or change another's definitions?         | No. `field_definitions` has RLS, every query is by tenant, and another company's field is a 404 with the same body as one that does not exist. Ordering with a foreign id is refused. A tenant in a header or body is ignored or 422.                                                                                                                                                                                                               |
| Is a hidden field's existence leaked?                        | No. The form list omits any field the caller cannot read, so no box and no label exists for it; a write to it is refused exactly as a write to a field that was never defined. The management view (settings read) is not filtered, because it describes configuration, not data, and is tested to show the field.                                                                                                                                  |
| Can a request destroy data through a definition?             | Not through the application role. `DELETE` is revoked; `UPDATE` is column-narrowed so `key`, `type`, `object_type`, `is_system` and `tenant_id` cannot be written at all; a trigger refuses an update that drops a picklist value; the worker may only read. `customization.security.spec.ts` in `@crm/db` proves each against the real roles and **fails exactly those tests with the migration's narrowing removed** (14 of 14 mutations caught). |
| Is there a way to delete a field?                            | No endpoint, no screen control, no grant. Deactivating hides it and stops writes; the data is kept and returns on reactivation (tested, including by reading the stored value around the switch).                                                                                                                                                                                                                                                   |
| Can a tenant-supplied pattern run on the server?             | No. `pattern` is rejected on every type at the contract and again in the rules; a pattern stored before this module existed is not shown. The prerequisite for offering one is a time-bounded regex engine (ADR-0039).                                                                                                                                                                                                                              |
| Can the client choose a key, a type change or a system flag? | No. The key is made from the label on the server; type is fixed after creation; every body is `.strict()`, so `key`, `type`, `isSystem`, `position`, `tenantId` and `ownerId` are 422, each tested.                                                                                                                                                                                                                                                 |
| Can an administrator fill the page or the table?             | No. At most 60 custom fields per object per company, 100 options per picklist, label 80, section 60, help text 280 characters, all as CHECKs; the cap is taken under an advisory lock and proven with a deliberately overlapping pair of transactions, and by a request-level test of three simultaneous creations.                                                                                                                                 |
| Is there stored XSS through a label or option?               | A label is stored as typed and returned as JSON; the web app renders every label and option as React text and a URL value as a link only if its scheme is http or https (`safeHref`, tested for `javascript:`, `data:` and `file:`). A test stores markup and quotes in a label and reads them back unchanged.                                                                                                                                      |
| Does a second administrator overwrite the first?             | No. Edits carry `version`; a stale one is a 409 and changes nothing, in the service and again in the `UPDATE`'s `WHERE`. Each guard alone leaves the other, so the test removes both.                                                                                                                                                                                                                                                               |
| Does switching a field off leak through search or export?    | Search does not index custom fields at all (`core/search`), and import and export already skip inactive fields (`import-rows`, `export-handler`, `targets`).                                                                                                                                                                                                                                                                                        |
| Is it audited?                                               | Creating and editing write an `audit_logs` row (`field_definition`) with what changed, and an outbox event; an edit that changes nothing writes none, and a reorder that changes nothing writes none.                                                                                                                                                                                                                                               |

The guards were mutation-tested: each authorization check, the form-list filter, the
management-view exemption, the system-field refusal, both version checks (alone, then
together), key uniqueness, the cap's translation to a 422, the ordering checks, the audit
and event writes, the strictness of each contract object, the types an administrator
can create and every database grant, trigger and CHECK were removed in turn and the
specs had to fail. The rounds found three real gaps, all since closed: a concurrency
test whose transactions did not actually overlap, no test that the management view is
unfiltered, and no test for a pattern stored before this module existed. Guards that are
redundant by design (the two version checks; the contract’s and the rules’ refusal of a
pattern) were removed together, since removing either alone leaves the other.

### Known gaps, deliberately

- **`user_lookup`, `pattern` and `unique` cannot be set from the screen.** The engine
  supports them; each waits for something this module does not build (a member picker
  non-administrators can use, a time-bounded regex engine, per-company index DDL).
- **Built-in fields cannot be relabelled or reordered.** The spec allows it; the screens
  that draw them have their own labels, so it would be invisible.
- **A switched-off field still counts against the 60.** No purge path exists.
- **A narrowed limit is not applied to existing records.** A new maximum length applies to
  the next write; a record already over it stays readable and its other fields stay editable.
- **List columns are chosen per visit.** Saved views (M4) will remember them. Filter and
  sort by a custom field are available through the API and have no screen yet.
- **The index of a company's definitions is not cached.** Each form and record page reads
  it (five minutes in the browser); a company with the maximum is 60 rows an object.

## Outbound requests and the browser's policy (§5.13, ADR-0040), reviewed

Hardening, not a feature: the rules a server obeys before it connects anywhere, and what the
web tier tells the browser. Reviewed for what a hostile destination or a hostile page could do.

| Question                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a request reach a private, loopback, link-local or metadata address? | Not through `OutboundHttp`. Default deny in `classifyAddress`: every special-purpose IPv4 range, IPv6 only inside `2000::/3` minus Teredo, documentation and 6to4, IPv4-mapped judged by the address inside, NAT64 refused, hostile spellings (`2130706433`, `0x7f.1`, `127.1`, `010.0.0.1`) resolved by the URL parser and refused as what they are. 180 table-driven tests.                                                                                   |
| Can DNS rebinding get round the check?                                   | No. The client resolves the name once per hop, judges every answer, and connects to the address it judged through a pinned `lookup`. A name with one public and one private answer is refused. A test shows the socket reaches a name that does not exist in DNS only because the resolver said so, and that the resolver was asked once.                                                                                                                       |
| Can a redirect carry it somewhere else, or carry credentials with it?    | Each hop is parsed, judged and resolved afresh; a redirect to metadata, to `file:`, to a URL with userinfo or to a blocked address is refused and the target never contacted. Caller-attached headers other than a short safe list are dropped when the origin changes.                                                                                                                                                                                         |
| Can a server hold or fill a worker?                                      | One deadline across lookup, connect, redirects and body (a resolver that never answers times out); a declared length over the cap is refused before reading and a streaming cap stops an endless body; identity encoding only.                                                                                                                                                                                                                                  |
| Can a caller smuggle a header or a body?                                 | Host, cookie, framing, upgrade and `proxy-*` headers are the client's; CR, LF and NUL in a name or value, and a name that is not a token, are refused.                                                                                                                                                                                                                                                                                                          |
| Can production code skip the guard?                                      | `boundary.spec.ts` reads `apps/api`, `apps/worker`, `apps/web` and `packages` and fails on a raw `fetch`, a network module, an HTTP library, a browser network API, TLS verification switched off or an import of the test-only client. The allow-list (web proxy, the browser's fetch wrapper, the client itself) is checked both ways. Not seen: the S3 SDK (one fixed endpoint) and Better Auth's Google sign-in (fixed hosts).                              |
| Does the web app send a CSP?                                             | Yes, on every page: nonce per request, `strict-dynamic`, no `unsafe-inline` or `unsafe-eval` for scripts in a production build, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`/`form-action` `'self'`, `connect-src` the app and the object store. HSTS in production. **Correction to what this review said earlier:** the API already ran helmet with a strict CSP and HSTS; the web app, which is what a browser renders, sent neither until now. |
| Is it enforced, or only written?                                         | `e2e/hardening.spec.ts` (12 checks, production build): nonce on the page matches the header and differs per request; markup with no nonce put into the real response does not run and the browser reports it as a `script-src` violation; twelve pages of the product and a record page report **no** violation.                                                                                                                                                |
| Can the credential proxy be pointed elsewhere?                           | The origin is fixed in configuration; `upstreamPath` now also fixes the path inside `/api/v1` (no dot segments, separators, control characters or oversized paths). Honest finding: nothing is outside `/api/v1` today and Next resolves `%2e%2e` itself, so this is defence in depth.                                                                                                                                                                          |

**How it was tested.** 127 deliberate breaks of the rules, the client, the boundary scan, the CSP builder and the
proxy path, each of which must make a test fail; a mutation whose suite did not run counts as an error. The first
pass caught 111; fifteen survivors were triaged, ten were real gaps and now have tests (the exact redirect limit,
a POST after a 302, NUL in a header, bad header names, the declared-length refusal, an unbounded resolver, a space
in a path, an HTTP default port, mixed-case host pins, a wildcard pin matching its own suffix, the pinned lookup's
two shapes). **123 of 127 are caught; four survive and are explained in ADR-0040** (three redundant defences and one
untestable without a TLS fixture).

**Findings that changed the code:** the client bundle carried a `util` polyfill and Zod's `new Function` probe, both
reported by the CSP as `eval`; fixed at the cause (`sideEffects: false` on `@crm/core`, Zod `jitless`) rather than
by allowing `unsafe-eval`.

## Hardening B: load test, search at scale, production readiness (ADR-0041), reviewed

The Week 6 load test at one million contacts, plus what it exposed. Reviewed for what a hostile or merely
unlucky caller could do, and for what production would silently accept.

| Question                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Could a caller read a field they may not see through the list search box? | **Yes, before this review.** `q` matched first name, last name, email and phone (and name/subject on deals and activities, and in exports) whatever field permissions said, so `q=@gmail` returning rows was the same leak as filtering on a hidden column. Fixed in five lists and in exports: the searchable fields are intersected with `canReadField`; a caller who may read none gets no matches. `search-fields.security.spec.ts` (7 tests, an administrator as control); with the leak restored all 7 fail. |
| Does the search index respect tenant, record scope and field permissions? | Unchanged and now stated as a contract: `describeSearchProviderContract` checks tenant isolation, own scope, hidden fields and removed records for any provider, and runs against Postgres under RLS.                                                                                                                                                                                                                                                                                                              |
| Does routing `q` through the index widen what a list can show?            | No: the index returns candidate ids, and the list still applies its own record scope, filters and RLS (`id in (…)`). An index that is stale can only under-show or show a record the list's own predicate then drops.                                                                                                                                                                                                                                                                                              |
| Can an export be made to leak or silently truncate through `q`?           | It uses the same call with a limit of 5,000 and is refused, not cut short, when more match. The parity test runs list and export on the same search.                                                                                                                                                                                                                                                                                                                                                               |
| Can a slow search starve the API?                                         | Bounded: every search statement runs under a two-second limit inside a savepoint (the request's tenant transaction survives); past it, `503 SEARCH_TIMEOUT`. `timeout.spec.ts`. Verified live.                                                                                                                                                                                                                                                                                                                     |
| Can overload leak internals?                                              | Pool exhaustion is `503 SERVICE_BUSY` with `Retry-After: 2` and no stack trace (`domain-error.filter.spec.ts`). It was a generic 500 with a trace per request.                                                                                                                                                                                                                                                                                                                                                     |
| Does an exact email lookup depend on a non-leakproof function?            | It did (`citext` equality, so a full scan of the tenant's contacts). Now `email::text = lower($1)` with a CHECK that emails are lower case; a canary test records why.                                                                                                                                                                                                                                                                                                                                             |
| Can production start with development secrets or insecure endpoints?      | No. `assertProductionConfig` (api and worker, production only) lists every problem, naming variables, never values: placeholder/short `AUTH_SECRET`, console or memory email, memory storage, http/localhost URLs, `*` CORS, superuser or dev-password database URL. 43 tests.                                                                                                                                                                                                                                     |
| Is the email provider's key safe?                                         | Resend REST through `OutboundHttp`, pinned to `api.resend.com:443`; no `Authorization` across redirects; errors carry a status and Resend's error name only (a response that echoes the request is tested).                                                                                                                                                                                                                                                                                                        |
| Can the filled-in production env file be committed?                       | It could have been; `.gitignore` now ignores `deploy/*.env` and keeps `*.env.example`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Does a restore lose security properties?                                  | The drill checks RLS enabled **and forced** on every tenant table, identical policies and grants, no `BYPASSRLS` role, the application role seeing one tenant and none with no tenant set. It found that a dump does not carry the LEAKPROOF marks (performance, not isolation) and that a restore needs `ANALYZE`.                                                                                                                                                                                                |
| Does the product need a superuser?                                        | No (a decision). The marks are best effort; without them rare-word search is slow and bounded at two seconds. Measured numbers in `docs/PERF.md` and `docs/RUNBOOK.md` §0.                                                                                                                                                                                                                                                                                                                                         |
| Accessibility                                                             | Automated pass on twelve screens in light and dark: one real defect (audit log without `h1`) fixed. A floor, not a review by a person.                                                                                                                                                                                                                                                                                                                                                                             |

**How it was tested.** The `q` leak was mutation-checked by restoring it (7 of 7 new tests fail). The rest of this
module's guards were then broken on purpose, 69 times: each production-config rule, the Resend adapter's pinning,
key checks and retry classification, the search time limit, the candidate and document caps, `truncated`, the typo
pass, the list's search wiring and the overload response, each of which must make a test fail. The first pass caught
54; fifteen survivors were triaged. Thirteen were real gaps and now have tests (the list asking for 300 and passing
`truncated` through, a one-character word narrowing nothing, the Resend port and host pins, a 3xx answer being a
failure, the worker not being held to a CORS list, `memory` email being refused for delivering nothing, the document
cap, a cut-short scan, no typo pass after one, the typo pass's own truncation, the fetch-one-more check). Two (the
candidate caps) were killed by the run, not by a new test: the search mutations had been pointed at the wrong spec path,
so they ran against none of the perf tests. One mutation ("fetch `limit + 5` ids instead of `limit + 1`") returns
identical results and was replaced by "fetch `limit`". **All 69 are now caught.**
**Found by the load test, in order of seriousness:** the `q` field-permission leak; exact email lookups reading the
whole table; global search taking 3 to 6 s for a common word (and a rep paying as much as an administrator); list
search reading the whole table for a typo (3.7 s); an API with no stated behaviour under overload. All fixed;
numbers before and after in `docs/PERF.md`.

**Residual risk, stated:**

- A database without the LEAKPROOF marks returns `SEARCH_TIMEOUT` for a mistyped search at a million records.
- Rate limits were per process until ADR-0042; they are now shared through Redis (see the section below).
- One API process fails past about 65 requests/s of mixed traffic; the fixed per-request cost is not investigated.
- Migrations 0020 and 0021 take locks while building indexes; on a large live table build them `CONCURRENTLY`
  outside the runner (RUNBOOK §3).
- No screen reader or person has used the product; the Resend adapter has never sent a real message (the tests use a fake client).

## Rate limits shared across instances (§5.14, ADR-0042), reviewed

Hardening, not a feature: the three in-process limiters moved behind one counter that Redis shares, after reading them
for what they actually did.

| Question                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Was the per-user limit per user?                          | **No, before this review.** The general limiter ran in `onRequest`, before `AuthGuard` set `request.actor`, so its key was always the address. An office shared one budget and one person on two addresses had two. Fixed: the user limit is spent in `AuthGuard` after the actor is resolved, keyed on the session-proven user. `rate-limit.security.spec.ts` failed on the old code and passes on the new. |
| What did a refused request look like?                     | **A 500**, with a stack trace logged, because the plugin threw an error our filter did not know. Now a `429 RATE_LIMITED` with `Retry-After`.                                                                                                                                                                                                                                                                |
| Can a caller spend somebody else's budget?                | Not through a header: user and tenant come from the session and the membership. An attacker who sends made-up tokens spends only their own address budget, which is also counted before the session lookup that each would cost.                                                                                                                                                                             |
| Do limits hold across instances?                          | Yes: two real instances on one Redis refuse together for the user, tenant, address and sign-in limits (`rate-limit.shared.security.spec.ts`). Counted per process the same traffic would be allowed twice.                                                                                                                                                                                                   |
| What happens if Redis is down?                            | The API keeps serving and limits per process (tested by stopping and restarting Redis under two instances). Not unlimited, not refused. One warning per 30 s, never the error text (a connection error can carry a password).                                                                                                                                                                                |
| Can the counter be left without an expiry (a lockout)?    | No: one atomic script sets the expiry with the first hit and repairs a key that has none (tested by writing one by hand).                                                                                                                                                                                                                                                                                    |
| What is in Redis?                                         | `crm:rl:v1:<kind>:<id>` keys holding a number: user and tenant ids and client addresses, expiring with the window. Nothing a person typed (asserted by scanning every key).                                                                                                                                                                                                                                  |
| Do responses tell a caller how to pace themselves?        | No. The body says whose budget it is, not the ceiling or what is left; `Retry-After` is the only header. The plugin's `X-RateLimit-*` headers are gone.                                                                                                                                                                                                                                                      |
| Can production start with per-process limits by accident? | No: without `REDIS_URL` the API refuses to start unless `RATE_LIMIT_ALLOW_PER_PROCESS=true` says one instance. A Redis URL with no password, or on this machine, is refused.                                                                                                                                                                                                                                 |
| Does the health route stay up under a flood?              | It is not limited, so a load balancer polling it is not refused; it does no per-request work.                                                                                                                                                                                                                                                                                                                |

**Residual risk, stated:**

- During a Redis outage N instances allow up to N times a limit.
- Limits are fixed windows: a caller can send up to twice a limit across a window boundary.
- An address budget of 1,000 a minute is a guess sized for an office; it has not been tuned against real traffic.
- Every request now makes one or two Redis calls; measured cost is in PERF.md §8.
- A Redis that evicts keys resets limits silently; RUNBOOK §4.1 says not to use one, and nothing checks it.

## The OpenAPI document (ADR-0027), reviewed

Generated from the Zod contracts and served at `GET /api/v1/openapi.json`. It
adds no database access, no input and no state change, so §5 rules 1, 2, 4–7
and 10–13 are untouched by it. Two rules are:

**§5.3, default deny.** It is one more route reachable without a session,
bringing the total to fourteen, so it is listed here rather than left to be
discovered. The other thirteen — liveness, readiness, the sign-up and sign-in
pair, the MFA second step, email verification, the password-reset pair, the two
Google routes and the two invitation-acceptance routes — are unchanged.

### What is deliberately public, and why this one is

`GET /api/v1/openapi.json` is `@Public()`. An integrator reads the spec before
they have credentials, which is the whole premise of ADR-0007, and the document
is built from `packages/contracts` — a package that holds no secret, no
configuration and no tenant data. It describes the shape of a surface the web
bundle already names.

It is not left to good intentions:

- `packages/contracts/src/openapi.spec.ts` asserts the serialised document
  contains no `AUTH_SECRET`, no `DATABASE_URL`, and no `postgres://` or
  `redis://` string.
- `apps/api/src/openapi/route-drift.spec.ts` asserts the endpoint answers 200
  without a session **and** that its body carries none of those, so a change
  that put real configuration into the document, or quietly moved the route
  behind the guard, is a failing test rather than a surprise.
- The document itself states that every endpoint except health requires a
  session, and marks each of the fourteen public operations `security: []`.
  `openapi.spec.ts` pins that list by name: a new public route changes a test,
  which is the point at which somebody has to agree it should be public.

**§5.14, rate limiting.** The route sits behind the address limit registered in
`bootstrap.ts` (formerly `@fastify/rate-limit`, replaced in ADR-0042), keyed by IP for a
caller with no session, like every other public route. It does no work per request — the document is built
once at module construction — so it is cheaper to serve than liveness.

### What it does not become

The document is generated from contracts that already exist and is **never read
at request time**. Authentication, tenancy and permissions are enforced exactly
where they were before: the guards, the services and the serializers. The route
registry describes the API; it does not decide anything about it, and the drift
test enforces that direction by reading Fastify's real routing table and holding
the registry to it rather than the reverse (ADR-0027).

## The M1 acceptance criteria, and where each is proved

| Criterion (MVP_SPEC M1)                                                 | Proved by                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 5 failed logins in 10 min, further attempts delayed + `auth_events` row | `auth.spec.ts` "delays further attempts after five failures and records the event" |
| Changing the password revokes all other sessions                        | `auth.spec.ts` "revokes all other sessions and keeps the caller signed in"         |
| A tenant with "MFA required" blocks access until the user enrols        | `auth.spec.ts` "blocks access until enrolment when the workspace requires MFA"     |

## What this review changed

Four gaps were found while writing it. The first two came out of the previous
round and were fixed then; the last two came out of building M1:

1. **No per-tenant rate limit (§5.14).** Only per-user and per-IP limits
   existed, so one tenant with many users across many addresses was unbounded.
   Now enforced in `AuthGuard` after the actor is resolved, keyed on the tenant
   membership proved rather than the header the client sent — keying on the
   header would have let a caller burn through another workspace's budget.

2. **No CSRF defence on the cookie-authenticated proxy (§5.9).** The web app's
   `/api/proxy/*` and `/api/session` routes authenticate by cookie, so any page
   on the internet could have driven them as the signed-in user. SameSite=Lax
   already blocked the cookie on a cross-site POST, but a single cookie
   attribute is a thin place for the whole defence to live. Both routes now
   verify `Origin` on state-changing methods, with tests for the cross-origin
   case, the missing-header case, and that same-origin writes still work.

3. **A credential sent in a `DELETE` body was silently dropped (§5.9).**
   Turning MFA off requires the password, which was sent as the body of
   `DELETE /auth/mfa`. The web app's own proxy strips bodies from `DELETE`, as
   much of the path between a browser and an API does, so the password never
   arrived and the endpoint refused every attempt. Playwright caught it; the
   API tests had not, because Fastify's `inject` is happy to send one. It is
   now `POST /auth/mfa/disable`. The lesson generalises: a security check that
   travels in a `DELETE` body is a security check that may not travel at all.

4. **The web app never read the monorepo's `.env` (§5.8).** Next only looks in
   its own directory, so while the API, worker and seed all read the root file,
   the web app quietly fell back to its compiled-in defaults — `API_URL` among
   them. Nothing failed; it simply talked to whatever the default pointed at,
   which is the worst shape a configuration bug can take. `next.config.ts` now
   loads the root file, without overriding anything already in the environment.

## What building Accounts changed

Four defects, found while copying the Contacts template onto a second object.
Three were latent in the template itself, which is the most useful thing this
module produced: Leads and Deals were about to inherit all three.

1. **The keyset predicate detached the record-scope filter (§5.4, §5.5).** The
   worst of the four. Drizzle's `and()` parenthesises its result but not its
   operands, and the keyset fragment contains a bare `or`, so the WHERE clause
   parsed as `(tenant and owner and keyset…) or <sort column> is not null`.
   RLS still held the tenant line, so this was never a cross-tenant leak — but
   **inside** a tenant, a rep on `own` scope saw every colleague's records from
   page two onward, whenever the list was sorted by a nullable column and a
   page boundary fell on a null. Every existing test sorted by a `NOT NULL`
   column, which is why nothing noticed. The predicate now lives in
   `apps/api/src/common/keyset.ts`, bracketed as a whole, and both modules have
   a regression test that pages a rep through a nullable sort and asserts every
   row returned is theirs. Both tests were confirmed to fail against the old
   code before the fix was kept.

2. **The same predicate dropped or repeated rows around NULLs.** Postgres
   orders NULLs last for ASC and first for DESC, and `NULL > 'x'` is NULL, so
   which half of the comparison must be stated explicitly depends on the
   direction. The old form was right for DESC and wrong for ASC: sorted
   ascending by a nullable column, paging either lost the null tail or served
   the first page forever, so an infinite scroll never ended. Correctness
   rather than security, but it is the same four lines.

3. **A foreign key alone does not mean "in this tenant" (§5.1).**
   `parent_account_id` is the first column that takes an id from the client and
   stores it. Referential checks run with row security off, so a key to
   `accounts (id)` would have accepted another tenant's row — no leak, since
   reading the parent is still scope-checked, but a permanent cross-tenant
   reference in a table we call isolated. It is now composite on
   `(tenant_id, parent_account_id)`, which makes the rule structural
   (ADR-0018). The error for a foreign parent is byte-identical to the one for
   an id that exists nowhere, so the field is not an existence oracle; asserted.

4. **The audit diff could not serialise a `bigint` (§5.10).** `diffChanges`
   compared values with `JSON.stringify`, which **throws** on a BigInt rather
   than rendering it. Accounts is the first object with money on it, so the
   first `PATCH` touching revenue returned a 500 — and would have taken the
   audit entry for the unrelated fields in the same request with it. Bigints
   are now rendered as decimal strings, for the reason the API sends them that
   way: a number past 2^53 would be rounded, and an audit log that disagrees
   with the record is worse than none, because it will be believed.

Two decisions recorded rather than fixed:

- **The parent lookup is tenant-scoped, not record-scoped.** A rep with `own`
  scope may file their account under a parent they cannot read. Deliberate: the
  group company usually belongs to a manager, and requiring visibility would
  make the hierarchy unmaintainable by the people who maintain it. Nothing of
  the parent is returned — reading it still goes through `can()`, and the
  record page falls back to a neutral label when the name is not readable. The
  residual exposure is that a caller can learn whether an id they already hold
  names an account in their own tenant. Ids are UUIDv7; that is not a space
  anyone can walk.
- **`billing_address`, `shipping_address` and `parent_account_id` have no
  `field_definitions` row**, and neither do `address`, `account_id` or
  `consent` on contacts. No field type describes them: `record_lookup` is P1
  and there is no address type (MVP_SPEC §6.3). The serializer still checks
  `canReadField` for them by key, so a permission row written by hand is
  honoured, but the admin UI will have nothing to offer until those types
  exist. Worth closing before M9 ships the customization screen.

## Dependency audit, and the one accepted exception

`pnpm audit --audit-level=high` runs in CI (MVP_SPEC §8). It was failing on
`master` — and had been since the job was written, unnoticed only because there
is no remote yet and CI has never run. Three findings, all in **build-time
dependencies**, none reachable from the deployed API, worker or web runtime:

| Advisory            | Severity | Package                         | Reached through                                          | Fix available                                                                                       |
| ------------------- | -------- | ------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GHSA-vfj7-8cjw-p6xm | **high** | `braces` 3.0.3                  | `tailwindcss` → chokidar / fast-glob / micromatch        | **None.** The advisory covers `<=3.0.3` and 3.0.3 is the latest release                             |
| GHSA-67mh-4wv8-2f99 | moderate | `esbuild` 0.18.20               | `drizzle-kit` → the deprecated `@esbuild-kit/*` packages | Yes (`>=0.25.0`), but not at that depth without forcing a major bump on a package that is abandoned |
| GHSA-rj75-hqrm-r3gf | moderate | `postcss-selector-parser` 6.1.4 | `tailwindcss`                                            | Yes (`>=7.1.6`), a major bump inside Tailwind's own tree                                            |

Only the first fails the gate, because the other two are below the threshold.

**The high one is ignored explicitly**, via `pnpm.auditConfig.ignoreGhsas` in
the root `package.json`, because there is nothing to upgrade to. An ignore list
was chosen over narrowing the job to `--prod`: scoping it away would also hide
every future dev-dependency advisory, including ones that do have fixes, and
build tooling is a real supply-chain target. `pnpm audit` still prints
`1 high (1 ignored)`, so the exception is visible in the log rather than
silent, and **any other high finding still fails CI**.

Re-run on 2026-10-22 after the outbound package landed: the same three advisories, nothing new
(`@crm/outbound` has no dependency beyond `@crm/core`).

Revisit when: `braces` publishes a fix, or Tailwind is upgraded to v4 (which
drops this dependency chain and would also clear the `postcss-selector-parser`
finding). The `esbuild` one goes away with `drizzle-kit`, which is only kept
for `pnpm db:generate`; migrations here are hand-written SQL, so that command
has never actually been used and the dependency is a candidate for removal.

## Known gaps, deliberately

These are not oversights; they belong to modules that have not been built.

- **Google sign-in is built but has never been run against Google.** The flow
  uses Better Auth's provider (ADR-0017) and the endpoints 404 cleanly when
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset, which is the state in
  development and CI. The `state` and PKCE verifier live in a short-lived
  httpOnly cookie, `state` is compared in constant time before the code is
  exchanged, and an existing account is linked **only** when Google reports the
  address as verified — without that check it is a pre-registration takeover.
  Exercising it needs real credentials, so it must be run in a staging project
  before launch. It is the one part of M1 no test covers.
- **Breached-password checking is not built.** MVP_SPEC M1 lists it as P1. The
  policy in `packages/core/auth` enforces length and a minimal character mix,
  which does nothing about a password already sitting in a breach corpus.
- ~~**Rate-limit counters are in-process**~~ Resolved by ADR-0042: every limit is
  counted in Redis, with a per-process fallback while Redis is unreachable.
- **Email has no real provider.** `EmailProvider` has a console adapter and a
  memory adapter for tests, and both refuse to start in production — so a
  production deploy fails loudly rather than writing verification links into a
  log file. Resend or SES is still to be written.
- **Audit coverage is partial.** Accounts, contacts, authentication and
  invitations. Every module added must write its audit entry in the same
  transaction, as `contacts.service.ts` does.
- **`GET /invitations/roles` lives in the invitations module.** Listing a
  workspace's roles belongs to the users-and-roles module M3 will build; it is
  here because the invite form is the only screen that needs it, and it sits
  behind the same `invitation:create` grant as inviting rather than behind a
  weaker one. Likewise the membership writes in `invitations.repository.ts`:
  `memberships` has no module of its own yet, and one place owning them is
  better than two.
- **Nothing cleans up spent invitations.** Accepted, revoked and expired rows
  stay forever, deliberately — they are the record of who invited whom. A
  retention job belongs with the rest of M11's data-rights work, not here.
- **Accounts has no duplicate detection on create.** MVP_SPEC M4 asks for it on
  domain and on name (fuzzy, via pg_trgm). The indexes and the repository
  lookup (`findByDomain`) exist; the rule that uses them does not, and belongs
  with import (M8), which is where duplicates actually arrive.
- **Addresses cannot be edited from the UI.** The API accepts and validates
  both and the record page renders them; a structured address needs a form
  rather than an inline field, which belongs with the record-page layout work
  in M9.
- **The column chooser does not persist.** Saved views own that (MVP_SPEC M4);
  writing it to browser storage first would only become something to migrate
  away from.
- **The E2E suite's sign-in budget is close to the per-IP auth limit.**
  `AUTH_RATE_LIMIT_MAX_PER_IP` is 50 per 15 minutes and the whole Playwright
  run comes from one address; adding a third object's tests took a clean run
  within a few attempts of it, and two runs back to back trip it. The accounts
  suite therefore shares one signed-in page per describe block instead of
  signing in per test. The limit is correct and must not be raised to make the
  suite fit — but Leads and Deals will each add to the same budget, so the
  contacts and auth suites should be given the same treatment before then.
- **Sign-up is not atomic across the role boundary.** Creating the identity and
  provisioning the workspace's roles happen as two different database roles,
  `crm_auth` and `crm_app`, so they cannot share a transaction. The tenant
  stays `provisioning` until the membership commits, and a failure in between
  deletes the user so the address is not permanently reserved — which matters,
  because the no-enumeration rule means the user would never be told why. That
  is a deliberate trade: the role split (ADR-0002) is worth more than the
  atomicity here, because the failure is self-correcting and the alternative
  would mean granting `crm_auth` write access to business tables.
- **Existing tenants have no deal grants and no pipeline.** Roles and the default
  pipeline are provisioned when a tenant is created, so a workspace that
  predates migration `0008` can sign in and be refused every deal route until it
  is given them. There is no backfill in the migration, and cannot be: the
  migration role is subject to the same forced row security as everyone else
  and has no policy on tenant tables. No tenant exists outside development, so
  re-seeding is the fix today; a real deployment would need a one-off script
  that runs the same inserts per tenant.
- **Exchange rates and pipelines have no admin screen or write endpoint.** Both
  tables, the read paths and the conversion are built and tested (ADR-0021);
  rates are entered by seed or SQL. Both need a permission object of their own,
  which belongs with M3 and M9.
- **The deal timeline is projected but not shown.** `deal.created`, `.updated`,
  `.deleted` and `.stage_changed` reach `timeline_events` through the worker
  (tested against the real relay), but no record page renders a timeline yet —
  contacts and accounts have the same gap. The acceptance criterion's "timeline
  entry" is therefore proved at the projection, not in the browser.
- **Account events are not projected to the timeline.** `apps/worker/src/main.ts`
  subscribes to contact and deal events only. Pre-existing, noticed while adding
  the deal handlers.
- **Board totals cost one rate query per column.** Six columns, six tiny reads
  inside one transaction. Fine at this size; if pipelines grow wide, fetch the
  rates once and pass them to the converter.
- **A deal's `amount` sorts by minor units**, so a sort across currencies orders
  ¥1,000 above ₹1,000. Meaningful only within one currency; sorting by converted
  value is a P1 reporting problem (ADR-0021).
- **Existing tenants have no lead grants and no lead field metadata.** The same
  situation as deals: roles and field definitions are provisioned at tenant
  creation, so a workspace that predates migration `0009` is refused every lead
  route (default deny, and nothing to read) until it is given them. No tenant
  exists outside development; re-seeding is the fix today and a real deployment
  needs a one-off per-tenant script.
- **Duplicate detection at import is built, but does not call
  `LeadsService.checkDuplicates`**: the worker cannot import API services, so
  `import-rows.ts` matches on one chosen field (email, phone, domain, name) inside
  the importer's read scope, which is the property ADR-0023 asks of any matching.
  It is exact, like the create path, and has no merge.
- **Duplicate matching is exact on email and phone and has no merge.** Plus-
  addressing and dotted Gmail variants are false negatives; merge is P1.
  Short-prefix company names ("Acme" against "Acme Trading") are a measured
  false negative (ADR-0023 §1).
- **Two simultaneous creates of the same lead both succeed**, by design: there is
  no uniqueness constraint, because legitimate duplicates exist (ADR-0023 §2).
- **Lead events reach the timeline but no record page renders a timeline yet**,
  the same gap contacts, accounts and deals have.
- **Outbound requests** (§5.13) are guarded but nothing calls the guard yet: no webhook, URL
  preview or other server-initiated fetch exists, so row 13 stays "built, no caller yet" until the
  email provider (the first caller) is wired through `OutboundHttp` (ADR-0040).
- **A rejected attachment keeps its row.** The bytes are deleted, but the row
  stays with `status = 'rejected'` and a reason, so the uploader is told why.
  It is never listed and never downloadable, and it counts against nothing.
- **A deleted attachment's bytes outlive the row by 30 days**, so that an
  undelete can bring the file back. No endpoint offers that undelete yet
  (ADR-0035 §7), so today the window is a cost with no feature behind it.
- **Orphan cleanup for attachments almost never runs**, because nothing in the
  product hard-deletes a record yet. The handler is correct for the day a
  Recycle Bin purge or an erasure request arrives (ADR-0035 §8).

## Things worth not forgetting

- `users` is global and intentionally has no tenant RLS policy. Access is
  scoped by joining `memberships`. Getting this backwards leaks the platform's
  entire user directory; it is tested.
- The worker reads `outbox_events` across tenants. That is the one documented
  exception to tenant scoping, confined to one table and one role, and it does
  not extend to business tables — also tested.
- `pnpm test:security` is a required CI gate. It is never made optional, and a
  failing isolation test is a release blocker, not a flake.
- **No response may reveal whether an address has an account.** Sign-up,
  resend-verification and forgot-password return the same acknowledgement
  whatever happened, and sign-in returns one error for "no such user" and
  "wrong password" — including in timing, which is why a lookup that found
  nobody still runs a hash comparison against a dummy. Six tests assert the
  responses are identical. It costs real usability, and the alternative leaks
  every address that has ever signed up.
- **An invitation token's prefix is not an authorization.** It names a
  workspace so the row can be read under RLS at all, and it is checked by
  finding the digest _inside_ that workspace. Anybody reading
  `parseInvitationToken` and seeing a tenant id come out of client input should
  read ADR-0019 before changing anything around it.
- **One-time tokens carry a `purpose`.** Without it, a link proving only that
  someone can read their email would be redeemable as a password reset. The
  column, its CHECK constraint and the test all exist for that one scenario.
- **Better Auth supplies primitives here, not sessions** (ADR-0017). Its
  session store keeps the token in plaintext; ours keeps a SHA-256 digest.
  Anyone tempted to adopt more of the library should read that ADR first.
- **There is exactly one statement in this system that updates `audit_logs`**,
  it runs on the `crm_erasure` connection, and it can only rewrite the `changes`
  column of rows belonging to a subject with an in-flight erasure request. If
  anybody is about to widen that — or to grant `crm_app` `UPDATE` on the table
  "just for a migration" — read ADR-0032 first. The alternative it rejected is
  the obvious one.
- **An audit diff is not metadata.** It holds the old and new _values_ of
  fields, so every read of it goes through `visibleAuditChanges`. A new read
  path over `audit_logs.changes` that does not call it is a field-permission
  leak, and the field being stripped everywhere else is exactly why nobody would
  notice.
