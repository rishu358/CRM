# ADR-0002: Shared database with `tenant_id` and Postgres Row-Level Security

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Tenant isolation is the single highest-consequence property of this system
(CLAUDE.md §5.1, MVP_SPEC §2 goal 2: _zero cross-tenant data exposure_). A bug in a
single `WHERE tenant_id = ?` clause among hundreds of queries would leak another
business's customer list. Application-level filtering alone makes every query a
potential breach.

Schema-per-tenant and database-per-tenant isolate more strongly but make migrations,
connection pooling and platform-wide queries dramatically harder at 1,000 tenants.

## Decision

A **single shared database**. Every tenant-owned table carries `tenant_id uuid NOT NULL`
and a **Row-Level Security policy** keyed on `current_setting('app.tenant_id')`.

Enforcement rests on three things, all of them required:

1. Every request runs inside a transaction that first issues
   `SET LOCAL app.tenant_id` and `SET LOCAL app.user_id`. `SET LOCAL` is scoped to the
   transaction, so a pooled connection cannot leak context into the next request.
2. The application database role (`crm_app`) has **no `BYPASSRLS`**, owns **no** tables,
   and is not a superuser. Migrations run as a separate role (`crm_migrator`) which
   owns the schema.
3. Every tenant table also sets `FORCE ROW LEVEL SECURITY`, so even the owning role
   is subject to the policy.

Isolation is therefore enforced by the database. A forgotten `WHERE` clause returns
zero rows rather than another tenant's data.

## Consequences

- The database is the last line of defence, not the application.
- Every data-access path must go through the tenant-scoped transaction helper.
  Code that opens a raw connection bypasses the guarantee and is forbidden.
- Platform-wide queries (admin analytics, billing) need an explicit, separately
  audited path; they cannot be done casually.
- A very large tenant cannot be moved to dedicated hardware without a
  `tenant_router` layer. We accept this for MVP; ADR-0013 keeps the door open.
- Integration and permission tests must run against **real Postgres with RLS enabled**
  (Testcontainers), never a mock (CLAUDE.md §10). A mocked database cannot prove
  isolation, which is the only property that matters here.

## Alternatives considered

- **Application-level filtering only.** Rejected: one missing predicate is a breach.
- **Schema per tenant.** Rejected: 1,000 schemas times N tables makes migrations and
  connection pooling unmanageable, and does not remove the need for correct code.
- **Database per tenant.** Rejected for MVP: strongest isolation, highest operational
  cost; reserved for enterprise customers later via ADR-0013.
