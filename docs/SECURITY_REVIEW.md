# Security self-review

Required by CLAUDE.md §11.5 after each module. This covers the foundation plus
the Contacts, Auth and Invitations modules, reviewed against §5 rule by rule.

Reviewed: 2026-10-17 · Scope: `packages/core`, `packages/db`, `apps/api`,
`apps/worker`, `apps/web` (Contacts, Auth, Invitations).

## §5 rule by rule

| #   | Rule                                                             | State         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation: `tenant_id` + RLS, `SET LOCAL`, no `BYPASSRLS` | **Met**       | `0004_rls_policies.sql`; 28 tests in `rls.security.spec.ts`, including a meta test that fails if any table with `tenant_id` lacks `ENABLE`+`FORCE`                                                                                                                                                                                                                                                                                     |
| 2   | Never trust the client for tenant, user, role, ownership         | **Met**       | Actor built only in `ActorService` from session + memberships; `X-Tenant-Id` is re-checked against membership; `resolveOwner` refuses reassignment without `all` scope                                                                                                                                                                                                                                                                 |
| 3   | Every endpoint authorized via `can()`, default deny              | **Met**       | `AuthGuard` is global; routes are protected unless `@Public()`. A lint rule rejects inline role comparisons                                                                                                                                                                                                                                                                                                                            |
| 4   | Field-level permissions applied in the serializer                | **Met**       | `contacts.serializer.ts`; hidden fields omitted (not nulled) and rejected on write                                                                                                                                                                                                                                                                                                                                                     |
| 5   | No IDOR; 404 not 403 outside scope                               | **Met**       | `assertCan` maps out-of-scope to 404; a test asserts the 404 for a foreign record is byte-identical to one for an id that does not exist                                                                                                                                                                                                                                                                                               |
| 6   | Zod validation at the boundary, unknown keys rejected            | **Met**       | `.strict()` contracts; a body carrying `tenantId` is a 422                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | No SQL string concatenation; whitelisted sort/filter             | **Met**       | `contacts.sql-helpers.ts` resolves every client-supplied key against field metadata; injection attempts through `sort` and `filter` are tested                                                                                                                                                                                                                                                                                         |
| 8   | Secrets from the environment; never logged                       | **Met**       | Validated env modules are the only readers; pino redaction list; `.env` is git-ignored                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Secure cookies, CSRF, MFA, rate-limited auth, revocation         | **Met**       | Cookie is httpOnly/SameSite=Lax/Secure-in-prod, set server-side and never readable by page script (an E2E test asserts `document.cookie` and both web storages); CSRF origin checks on both cookie-authenticated routes; TOTP + backup codes with tenant-level enforcement in `AuthGuard`; progressive delay in `AuthThrottleService` plus a per-IP ceiling in `AuthRateLimitGuard`; revocation via `sessions_valid_from` in one write |
| 10  | Audit create/update/delete, logins, exports, role changes        | **Partial**   | Contacts CRUD, login, logout, password changes, **plus every invitation, acceptance and revocation**, each written in the same transaction as the change and append-only by withheld grants. A password change is audited in every workspace the user belongs to, because it affects access to all of them. Permission-change auditing arrives with M3                                                                                 |
| 11  | CSV export with formula-injection escaping                       | **Not built** | Export is not implemented yet                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | File type by magic bytes, presigned URLs                         | **Not built** | Attachments are not implemented yet                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | SSRF protection on outbound requests                             | **Not built** | No outbound requests exist yet                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | Rate limit per tenant **and** per user                           | **Met**       | Per-user/IP at the edge via `@fastify/rate-limit`; per-tenant in `TenantRateLimitService`, keyed on the membership-proven tenant so it cannot be spoofed                                                                                                                                                                                                                                                                               |
| 15  | Say so when unsure                                               | —             | This document                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Invitations (MVP_SPEC M2), reviewed

The module is the first thing in the product that writes a second
`memberships` row, so the whole permission engine only becomes reachable in
production because of it. Three decisions in it are security decisions, and all
three are written down in [ADR-0018](adr/0018-invitation-acceptance-identity.md)
rather than left implicit in the code.

| Question                                                       | Answer, and where it is proved                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a token join a workspace it was not issued for?            | No. The workspace is on the invitation's row; the token's prefix is a routing hint whose only effect is choosing an RLS context, so a swapped prefix matches no digest. `invitations.security.spec.ts` "cannot be pointed at another workspace"             |
| Can a token confer a role it was not issued with?              | No. `role_id` is read from the row at redemption and appears in no request body; the contracts are `.strict()`, so sending one is a 422. "confers only the invited role, whatever the recipient asks for"                                                   |
| Can somebody accept an invitation that is not theirs?          | No. Every identity check runs before the redeeming UPDATE, so a refused attempt leaves the link usable by the real recipient. "refuses somebody signed in as a different address, and leaves the link usable"                                               |
| Can an emailed link produce a session for an existing account? | No — that would walk past a second factor its owner enrolled. The recipient signs in first. "never issues a session from a link when the address already has an account"                                                                                    |
| Does inviting reveal whether an address has an account?        | No. The response is the invitation either way; the difference is only in the mail that address receives. The acceptance screen does say so, but only to somebody already holding a token mailed there (ADR-0018)                                            |
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
- **Audit coverage is partial.** Contacts, authentication and invitations.
  Every module added must write its audit entry in the same transaction, as
  `contacts.service.ts` does.
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
- **Sign-up is not atomic across the role boundary.** Creating the identity and
  provisioning the workspace's roles happen as two different database roles,
  `crm_auth` and `crm_app`, so they cannot share a transaction. The tenant
  stays `provisioning` until the membership commits, and a failure in between
  deletes the user so the address is not permanently reserved — which matters,
  because the no-enumeration rule means the user would never be told why. That
  is a deliberate trade: the role split (ADR-0002) is worth more than the
  atomicity here, because the failure is self-correcting and the alternative
  would mean granting `crm_auth` write access to business tables.
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
  read ADR-0018 before changing anything around it.
- **One-time tokens carry a `purpose`.** Without it, a link proving only that
  someone can read their email would be redeemable as a password reset. The
  column, its CHECK constraint and the test all exist for that one scenario.
- **Better Auth supplies primitives here, not sessions** (ADR-0017). Its
  session store keeps the token in plaintext; ours keeps a SHA-256 digest.
  Anyone tempted to adopt more of the library should read that ADR first.
