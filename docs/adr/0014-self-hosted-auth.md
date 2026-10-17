# ADR-0014: Self-hosted authentication (Better Auth) with data in our database

- **Status:** Accepted, amended by [ADR-0017](0017-better-auth-as-primitives-not-framework.md)
- **Date:** 2026-10-16

> **Amendment (ADR-0017).** The decision to self-host identity in our own Postgres
> stands. What changed is _how much_ of Better Auth we use: its password hashing,
> TOTP and OAuth providers, but not its session store, database adapter or HTTP
> handler — its session model stores the raw token, which we do not. See ADR-0017
> for the evidence.

## Context

Hosted identity providers (Auth0, Clerk, Cognito) are fast to adopt but price per
monthly active user, which scales badly against a per-seat SMB CRM. They also place
user records in a vendor's region, which collides with the residency commitment in
ADR-0013, and they make the `users` table a remote object that cannot participate in
our transactions, audit log or outbox.

## Decision

**Better Auth, self-hosted, with all identity data in our own Postgres database.**

- MVP covers email and password with verification, password reset, Google sign-in,
  TOTP MFA with backup codes, and session management with revocation.
- Sessions use httpOnly, Secure, SameSite=Lax cookies with CSRF protection on every
  state-changing request (CLAUDE.md §5.9).
- `users` is a **global identity** table: one person, one row, across every tenant
  they belong to. Tenant scoping lives in `memberships`.

### Critical isolation note

Because `users` is global, it is **not** a tenant-owned table and must **not** carry a
`tenant_id`-based RLS policy. Access to user records is scoped by joining through
`memberships`, which is tenant-owned and does carry RLS. Getting this backwards would
either break multi-tenant membership or leak the user directory across tenants, so it
is called out explicitly here and covered by tests.

## Consequences

- No per-user auth cost, and identity data stays in-region.
- Auth tables participate in our transactions, so a signup, its membership, its audit
  entry and its outbox event commit atomically.
- **We now own auth security**: password hashing parameters, rate limiting,
  token lifetimes, breach response. This is real, ongoing responsibility.
- SAML/OIDC SSO and SCIM (P2) must be built or bought separately.

## Alternatives considered

- **Auth0 / Clerk / Cognito.** Rejected: per-MAU cost, residency conflict, and
  identity outside our transaction boundary.
- **Hand-rolled authentication.** Rejected: session handling, MFA and token flows are
  exactly where hand-rolled code goes wrong.
