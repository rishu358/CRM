# Security self-review

Required by CLAUDE.md §11.5 after each module. This covers the foundation plus
the Contacts module, reviewed against §5 rule by rule.

Reviewed: 2026-10-16 · Scope: `packages/core`, `packages/db`, `apps/api`,
`apps/worker`, `apps/web` (Contacts).

## §5 rule by rule

| #   | Rule                                                             | State         | Evidence                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tenant isolation: `tenant_id` + RLS, `SET LOCAL`, no `BYPASSRLS` | **Met**       | `0004_rls_policies.sql`; 28 tests in `rls.security.spec.ts`, including a meta test that fails if any table with `tenant_id` lacks `ENABLE`+`FORCE`                                                |
| 2   | Never trust the client for tenant, user, role, ownership         | **Met**       | Actor built only in `ActorService` from session + memberships; `X-Tenant-Id` is re-checked against membership; `resolveOwner` refuses reassignment without `all` scope                            |
| 3   | Every endpoint authorized via `can()`, default deny              | **Met**       | `AuthGuard` is global; routes are protected unless `@Public()`. A lint rule rejects inline role comparisons                                                                                       |
| 4   | Field-level permissions applied in the serializer                | **Met**       | `contacts.serializer.ts`; hidden fields omitted (not nulled) and rejected on write                                                                                                                |
| 5   | No IDOR; 404 not 403 outside scope                               | **Met**       | `assertCan` maps out-of-scope to 404; a test asserts the 404 for a foreign record is byte-identical to one for an id that does not exist                                                          |
| 6   | Zod validation at the boundary, unknown keys rejected            | **Met**       | `.strict()` contracts; a body carrying `tenantId` is a 422                                                                                                                                        |
| 7   | No SQL string concatenation; whitelisted sort/filter             | **Met**       | `contacts.sql-helpers.ts` resolves every client-supplied key against field metadata; injection attempts through `sort` and `filter` are tested                                                    |
| 8   | Secrets from the environment; never logged                       | **Met**       | Validated env modules are the only readers; pino redaction list; `.env` is git-ignored                                                                                                            |
| 9   | Secure cookies, CSRF, MFA, rate-limited auth, revocation         | **Partial**   | Cookie is httpOnly/SameSite=Lax/Secure-in-prod; CSRF origin checks on both cookie-authenticated routes (tested). **Sign-in, MFA, password reset and auth rate limiting are not built** — see gaps |
| 10  | Audit create/update/delete, logins, exports, role changes        | **Partial**   | Contacts CRUD is audited in the same transaction, append-only by withheld grants. Login and permission-change auditing arrive with their modules                                                  |
| 11  | CSV export with formula-injection escaping                       | **Not built** | Export is not implemented yet                                                                                                                                                                     |
| 12  | File type by magic bytes, presigned URLs                         | **Not built** | Attachments are not implemented yet                                                                                                                                                               |
| 13  | SSRF protection on outbound requests                             | **Not built** | No outbound requests exist yet                                                                                                                                                                    |
| 14  | Rate limit per tenant **and** per user                           | **Met**       | Per-user/IP at the edge via `@fastify/rate-limit`; per-tenant in `TenantRateLimitService`, keyed on the membership-proven tenant so it cannot be spoofed                                          |
| 15  | Say so when unsure                                               | —             | This document                                                                                                                                                                                     |

## What this review changed

Two gaps were found while writing it, and both are fixed:

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

## Known gaps, deliberately

These are not oversights; they belong to modules that have not been built.

- **Authentication flows (MVP_SPEC M1).** No sign-up, sign-in, password reset,
  MFA or Google. The session layer underneath — hashed tokens, expiry,
  revocation, `sessions_valid_from` — is real and enforced; what is missing is
  everything that issues a session. The interim sign-in screen accepts a token
  from `pnpm db:seed` and mints nothing. Improvising credential handling is
  what ADR-0014 exists to prevent.
- **Per-tenant limit counters are in-process.** A real limit on one instance,
  none across several. Must move to Redis before horizontal scaling; it is
  written behind an interface for that reason.
- **Audit coverage is partial.** Contacts only, because contacts is the only
  module. Every module added must write its audit entry in the same
  transaction, as `contacts.service.ts` does.
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
