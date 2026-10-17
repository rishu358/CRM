# Security self-review

Required by CLAUDE.md §11.5 after each module. This covers the foundation plus
the Contacts, Auth, Accounts, Invitations, Deals, Leads and Activities modules,
reviewed against §5 rule by rule.

Reviewed: 2026-10-17 · Scope: `packages/core`, `packages/db`, `apps/api`,
`apps/worker`, `apps/web` (Accounts, Contacts, Auth, Invitations, Deals, Leads,
Activities/My Day/Notifications).

## §5 rule by rule

| #   | Rule                                                             | State         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation: `tenant_id` + RLS, `SET LOCAL`, no `BYPASSRLS` | **Met**       | `0004_rls_policies.sql`; 28 tests in `rls.security.spec.ts`, including a meta test that fails if any table with `tenant_id` lacks `ENABLE`+`FORCE`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | Never trust the client for tenant, user, role, ownership         | **Met**       | Actor built only in `ActorService` from session + memberships; `X-Tenant-Id` is re-checked against membership; `resolveOwner` refuses reassignment without `all` scope                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Every endpoint authorized via `can()`, default deny              | **Met**       | `AuthGuard` is global; routes are protected unless `@Public()`. A lint rule rejects inline role comparisons                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | Field-level permissions applied in the serializer                | **Met**       | `contacts.serializer.ts`, `accounts.serializer.ts`, `deals.serializer.ts`, `leads.serializer.ts`, `activities.serializer.ts` (which also re-sanitizes the rich-text body on the way out, ADR-0024); hidden fields omitted (not nulled) and rejected on write. Sorting and filtering are checked too (`common/field-queries.ts`): a column the caller cannot read cannot be ordered by or compared against either                                                                                                                                                       |
| 5   | No IDOR; 404 not 403 outside scope                               | **Met**       | `assertCan` maps out-of-scope to 404; a test asserts the 404 for a foreign record is byte-identical to one for an id that does not exist                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | Zod validation at the boundary, unknown keys rejected            | **Met**       | `.strict()` contracts; a body carrying `tenantId` is a 422. Rich text is additionally sanitized against an allow-list on write **and** on read (`@crm/core/html`, ADR-0024), with 46 payload tests in `html.spec.ts` and 9 stored-XSS tests through the API                                                                                                                                                                                                                                                                                                            |
| 7   | No SQL string concatenation; whitelisted sort/filter             | **Met**       | `contacts.sql-helpers.ts`, `accounts.sql-helpers.ts`, `deals.sql-helpers.ts`, `leads.sql-helpers.ts` and `activities.sql-helpers.ts` resolve every client-supplied key against field metadata; accounts also checks the filter **value** against the column type, so a bad one is a 422 rather than a driver error surfacing as a 500. Injection attempts through `sort` and `filter` are tested in both modules                                                                                                                                                       |
| 8   | Secrets from the environment; never logged                       | **Met**       | Validated env modules are the only readers; pino redaction list; `.env` is git-ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Secure cookies, CSRF, MFA, rate-limited auth, revocation         | **Met**       | Cookie is httpOnly/SameSite=Lax/Secure-in-prod, set server-side and never readable by page script (an E2E test asserts `document.cookie` and both web storages); CSRF origin checks on both cookie-authenticated routes; TOTP + backup codes with tenant-level enforcement in `AuthGuard`; progressive delay in `AuthThrottleService` plus a per-IP ceiling in `AuthRateLimitGuard`; revocation via `sessions_valid_from` in one write                                                                                                                                 |
| 10  | Audit create/update/delete, logins, exports, role changes        | **Partial**   | Accounts, Contacts, Deals, Leads and Activities CRUD (including attaching and detaching a polymorphic link) (a stage move included, with both stages in the diff; a lead conversion audited on the lead **and** on every record it creates), login, logout, password changes, **plus every invitation, acceptance and revocation**, each audited in the same transaction and append-only by withheld grants. A password change is audited in every workspace the user belongs to, because it affects access to all of them. Permission-change auditing arrives with M3 |
| 11  | CSV export with formula-injection escaping                       | **Not built** | Export is not implemented yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | File type by magic bytes, presigned URLs                         | **Not built** | Attachments are not implemented yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | SSRF protection on outbound requests                             | **Not built** | No outbound requests exist yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | Rate limit per tenant **and** per user                           | **Met**       | Per-user/IP at the edge via `@fastify/rate-limit`; per-tenant in `TenantRateLimitService`, keyed on the membership-proven tenant so it cannot be spoofed                                                                                                                                                                                                                                                                                                                                                                                                               |
| 15  | Say so when unsure                                               | —             | This document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
- **Duplicate detection at import is not built**, because import is not
  (MVP_SPEC M8). The create and convert paths are covered; the import module
  should call `LeadsService.checkDuplicates` per row rather than grow its own
  matching.
- **Duplicate matching is exact on email and phone and has no merge.** Plus-
  addressing and dotted Gmail variants are false negatives; merge is P1.
  Short-prefix company names ("Acme" against "Acme Trading") are a measured
  false negative (ADR-0023 §1).
- **Two simultaneous creates of the same lead both succeed**, by design: there is
  no uniqueness constraint, because legitimate duplicates exist (ADR-0023 §2).
- **Lead events reach the timeline but no record page renders a timeline yet**,
  the same gap contacts, accounts and deals have.
- **Export, attachments and outbound requests** (§5.11–13) have nothing to
  protect yet. Their rules must be satisfied as part of building them, not
  retrofitted.

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
