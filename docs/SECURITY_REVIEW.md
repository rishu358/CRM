# Security self-review

Required by CLAUDE.md §11.5 after each module. This covers the foundation plus
the Contacts, Auth, Accounts, Invitations, Deals, Leads, Activities, Search,
Import/Export and Audit/Recycle Bin/Data Rights modules, reviewed against §5
rule by rule.

Reviewed: 2026-10-19 · Scope: `packages/core`, `packages/db`, `apps/api`,
`apps/worker`, `apps/web` (Accounts, Contacts, Auth, Invitations, Deals, Leads,
Activities/My Day/Notifications, global search and the command palette, import
and export with the object-storage package, the audit viewer, the Recycle Bin,
DPDP/GDPR data rights, and the generated OpenAPI document).

## §5 rule by rule

| #   | Rule                                                             | State         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation: `tenant_id` + RLS, `SET LOCAL`, no `BYPASSRLS` | **Met**       | `0004_rls_policies.sql`; 28 tests in `rls.security.spec.ts`, including a meta test that fails if any table with `tenant_id` lacks `ENABLE`+`FORCE` — which `search_documents` has too, and which is why two text operators had to be marked `LEAKPROOF` for search to use an index at all (ADR-0028 §7, below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | Never trust the client for tenant, user, role, ownership         | **Met**       | Actor built only in `ActorService` from session + memberships; `X-Tenant-Id` is re-checked against membership; `resolveOwner` refuses reassignment without `all` scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | Every endpoint authorized via `can()`, default deny              | **Met**       | `AuthGuard` is global; routes are protected unless `@Public()`. A lint rule rejects inline role comparisons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Field-level permissions applied in the serializer                | **Met**       | `contacts.serializer.ts`, `accounts.serializer.ts`, `deals.serializer.ts`, `leads.serializer.ts`, `activities.serializer.ts` (which also re-sanitizes the rich-text body on the way out, ADR-0024); hidden fields omitted (not nulled) and rejected on write. Sorting and filtering are checked too (`common/field-queries.ts`): a column the caller cannot read cannot be ordered by or compared against either. Global search applies the same rule twice over — a hidden field is not matched on, in SQL, and `search.serializer.ts` re-checks the matched field before quoting it (ADR-0028)                                                                                                                                                                                                    |
| 5   | No IDOR; 404 not 403 outside scope                               | **Met**       | `assertCan` maps out-of-scope to 404; a test asserts the 404 for a foreign record is byte-identical to one for an id that does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | Zod validation at the boundary, unknown keys rejected            | **Met**       | `.strict()` contracts; a body carrying `tenantId` is a 422. Rich text is additionally sanitized against an allow-list on write **and** on read (`@crm/core/html`, ADR-0024), with 46 payload tests in `html.spec.ts` and 9 stored-XSS tests through the API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7   | No SQL string concatenation; whitelisted sort/filter             | **Met**       | `contacts.sql-helpers.ts`, `accounts.sql-helpers.ts`, `deals.sql-helpers.ts`, `leads.sql-helpers.ts` and `activities.sql-helpers.ts` resolve every client-supplied key against field metadata; accounts also checks the filter **value** against the column type, so a bad one is a 422 rather than a driver error surfacing as a 500. Injection attempts through `sort` and `filter` are tested in both modules. Global search tokenizes the caller's string to bare words in `@crm/core` before any query language sees it, so no `&`, `\|`, `!`, `:` or quote reaches `to_tsquery`                                                                                                                                                                                                               |
| 8   | Secrets from the environment; never logged                       | **Met**       | Validated env modules are the only readers; pino redaction list; `.env` is git-ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | Secure cookies, CSRF, MFA, rate-limited auth, revocation         | **Met**       | Cookie is httpOnly/SameSite=Lax/Secure-in-prod, set server-side and never readable by page script (an E2E test asserts `document.cookie` and both web storages); CSRF origin checks on both cookie-authenticated routes; TOTP + backup codes with tenant-level enforcement in `AuthGuard`; progressive delay in `AuthThrottleService` plus a per-IP ceiling in `AuthRateLimitGuard`; revocation via `sessions_valid_from` in one write                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Audit create/update/delete, logins, exports, role changes        | **Partial**   | Accounts, Contacts, Deals, Leads and Activities CRUD (including attaching and detaching a polymorphic link) (a stage move included, with both stages in the diff; a lead conversion audited on the lead **and** on every record it creates), login, logout, password changes, **plus every invitation, acceptance and revocation**, each audited in the same transaction and append-only by withheld grants. A password change is audited in every workspace the user belongs to, because it affects access to all of them. **Import jobs (created, started, completed with counts) and every imported record (tagged with its job id), and every export (requested, finished with the row count, each download link issued)** are audited the same way. **M11 adds the reading half: `GET /audit-logs` for roles holding `audit_log:read` at `all` scope, with each diff filtered through the same `canReadField` as every other read path (`visibleAuditChanges` in `@crm/core`, 11 tests in `audit-log.security.spec.ts` and 10 in `visibility.spec.ts`), plus `restore`, `purge`, `erase` and `redact` entries for the Recycle Bin and data rights, and three new archive kinds audited on request, on completion and on each link issued. The query shape is asserted against the planner in `audit-query.perf.spec.ts` (ADR-0031).** Permission-change auditing is the one piece still missing and arrives with M3 |
| 11  | CSV export with formula-injection escaping                       | **Met**       | `toExportCell` is the only route to an output file: every cell of the CSV and XLSX writers, the header row, and the import error file (which echoes the uploader's own cells), with no list of "columns to escape". Decided on the first non-whitespace character, so a leading space, NBSP or zero-width space does not hide a payload. Each trigger (`=` `+` `-` `@` tab CR, and LF) and each whitespace character is its own test on a system column, a custom field, a header and **imported data** (`export.security.spec.ts`), then the whole file is scanned. `export` is its own action, scoped, field-filtered, audited. **The three M11 archives go through the same writer: an audit-log CSV escapes every cell including the rendered diff, which holds values a user typed (`archive.security.spec.ts`). The whole-tenant and one-person archives are JSON only — a multi-table archive flattened into one CSV loses the links that make it answerable, and a zip of one file per table is the right shape and is deliberately not built (the API returns 422 rather than producing a lossy file).** ADR-0030 §8                                                                                                                                                       |
| 12  | File type by magic bytes, presigned URLs                         | **Met**       | For every file that exists (import uploads, generated exports, error files): magic bytes **and** claim-vs-bytes (`magic-bytes.ts`); size signed into the presigned PUT; zip bombs measured, not declared (`zip.ts`); random keys; 5/10-minute presigned URLs; the API never reads or writes bytes (counted in tests); tampered size, type, key and expiry refused by a real MinIO. **Record attachments are not built** and must reuse this; when they are, the purge and erasure paths need a `<object>.purged.v1` subscriber to delete their bytes (ADR-0031 §7). The M11 archives use the same signing path under a separate `data-exports` key prefix, so an operator can give them their own lifecycle rule. ADR-0030                                                                                                                                                                                                                                                                                                                                               |
| 13  | SSRF protection on outbound requests                             | **Not built** | No outbound requests exist yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | Rate limit per tenant **and** per user                           | **Met**       | Per-user/IP at the edge via `@fastify/rate-limit`; per-tenant in `TenantRateLimitService`, keyed on the membership-proven tenant so it cannot be spoofed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15  | Say so when unsure                                               | —             | This document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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
  spreadsheet. **Record attachments, malware scanning and eager deletion of
  expired files** are not built.
- **`exceljs` carries deprecated transitive dependencies**; the parser is isolated
  in `apps/worker/src/import-export/parse.ts`.
- **No eager sweep of expired export files**; the API refuses their links and the
  bucket's lifecycle rule removes them.

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
   converted camelCase→snake_case, because a *mapping* with a missing entry fails
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

| Constraint                                                     | Where                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tenant A's administrator cannot see tenant B's audit rows       | `audit-log.security.spec.ts` "tenant isolation", both directions      |
| A non-administrator cannot reach the viewer at all              | same file: Sales Rep, Manager, Read-only, and a narrower-scope grant  |
| The Recycle Bin does not list records outside the actor's scope | `recycle-bin.security.spec.ts` "record scope"                         |
| The tenant export contains only that tenant's data              | `archive.security.spec.ts`, against a neighbour with similar data     |
| The four mandatory §10 suites, per module                       | each module's `*.security.spec.ts`                                    |

### What building these changed

- **Three capabilities became object types** — `audit_log`, `tenant_data`,
  `data_subject` — so reaching any of them is a row in `role_permissions`, not an
  `if (role === 'Owner')`. Kept apart rather than folded into one `data_rights`
  type because a whole-workspace archive, one person's file and an irreversible
  erasure are not the same decision; one type would make granting the mildest
  grant the most dangerous one.
- **The audit viewer requires `all` scope.** `own` and `team` have no meaning on
  a log, and a half-working scope is worse than a refusal that says why
  (ADR-0031 §3).
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
  same transaction as the record (ADR-0031 §6–7).
- **The erasure's own audit entry carries counts, not values.** Recording what
  was erased would make that row the last place the erased data lives.

### Deliberately out of scope, and said so

- Redaction reaches the subject's **own** audit rows. Rows about related
  records — an activity mentioning the person, a deal named after them — are not
  scanned for values; widening that has a real cost and belongs in its own ADR.
- Whole-tenant and one-person archives are JSON only. CSV is refused with a 422
  rather than producing a file that silently loses the structure.
- The Recycle Bin has no "delete permanently now" action. The retention job is
  the only hard-delete path for records, which keeps one place to reason about.

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

**§5.14, rate limiting.** The route sits behind the global `@fastify/rate-limit`
registered in `bootstrap.ts`, keyed by IP for a caller with no session, like
every other public route. It does no work per request — the document is built
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
- **Rate-limit counters are in-process**, both the per-tenant one and the new
  per-IP auth one. A real limit on one instance and none across several. Both
  must move to Redis before horizontal scaling, and both sit behind the same
  `RateLimitCounter` interface for that reason.
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
- **Attachments and outbound requests** (§5.12 for records, §5.13) have nothing to
  protect yet. Export and the files import creates are covered (rows 11 and 12).
  Their rules must be satisfied as part of building them, not retrofitted.

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
- **An audit diff is not metadata.** It holds the old and new *values* of
  fields, so every read of it goes through `visibleAuditChanges`. A new read
  path over `audit_logs.changes` that does not call it is a field-permission
  leak, and the field being stripped everywhere else is exactly why nobody would
  notice.
