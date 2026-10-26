# ADR-0047: Entitlements: plans, features and per-workspace overrides

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0010 (the decision this implements), ADR-0046 (deployment modes), CLAUDE.md §6, MVP_SPEC §14

## Context

ADR-0010 decided the shape: one lookup, `entitlements.has(tenant, feature)`, plans mapped to features in
data, no plan name in business logic. Nothing implemented it. To be sold, the product needs the lookup to
exist and be enforced by the API, so that packaging (what a plan includes) can change without touching the
places that ask, and so that a single-tenant installation, which has nothing to sell, has everything.

The pricing model is an open question for the founder (MVP_SPEC §14). This ADR therefore builds the
mechanism and ships **no differences between plans**: nothing changes for any workspace until someone decides
what a plan is.

## Decision

### 1. One question, answered by a pure function

`resolveEntitlements({ mode, plan, overrides })` in `packages/core/src/entitlements` returns `has(feature)` and
a `snapshot()`. The rules, in order:

1. **Single-tenant installation: every feature on.** The operator owns it; plans and overrides are not
   consulted (ADR-0046).
2. Otherwise the features the **plan catalogue** lists for the workspace's plan.
3. Then each **override** on top, which may switch a feature on or off.

A plan the catalogue does not know includes **nothing** (default deny, CLAUDE.md §5.3), so a mistyped plan
fails closed. An override for a feature that no longer exists is ignored.

No plan name is compared anywhere (the lint rule from ADR-0010 still applies); the lookup is by catalogue key.

### 2. The catalogue is data in code; overrides are rows

- **Plan → features** is a typed table in `packages/core`. Changing packaging is a one-file edit and a deploy.
  This is a deviation from ADR-0010's "without a deploy", chosen deliberately: until the pricing model exists, a
  database catalogue is a migration, an admin surface and a cache-invalidation story for a table that would hold
  three identical rows. The per-workspace override table below covers the case that needs no deploy: a pilot, or
  a customer who has had something withdrawn. If plan packaging has to change without a deploy, the catalogue
  moves to a table behind the same function, and nothing that asks has to change.
- **Overrides** are rows in `tenant_entitlements` (`tenant_id`, `feature`, `enabled`, `reason`; one row per
  workspace and feature). `reason` is required: an exception nobody can explain is the first one deleted by
  mistake, or kept for years.

### 3. Who can write an override: the operator's role, and no request

A workspace must never be able to grant itself a feature. So:

- `crm_app` and `crm_worker` hold **`SELECT` only**, through a policy that shows a session its own workspace's
  rows. `crm_auth`, the platform-level role the operator's commands already run as (it creates workspaces and
  holds the `plan` column), holds the writes.
- The grant is the barrier; the policies restate it, so a later `GRANT` by mistake would still be stopped by
  row-level security. (Checked by mutation, not by a standing test: with `INSERT` granted to the application
  role by mistake, the policy still refused the write.)
- The write path, `EntitlementsOperator`, is **not exported** from the platform module. No controller or
  service can take it as a dependency, and no route reaches it. A test asserts both. Its only caller is
  `pnpm tenant:entitlements`.

No new database role was added: the privilege already exists in `crm_auth`, and a new role is an
infrastructure change for every deployment (the bootstrap is run once by an administrator).

### 4. Enforcement is in the API, after `can()`

`EntitlementsService.require(tx, tenantId, feature)` throws the existing `EntitlementRequiredError`
(`402 ENTITLEMENT_REQUIRED`, naming the feature). It is called **after** `can()`: a person who may not do
something is told 403 before they learn anything about the plan. It is read inside the request's transaction
(two small indexed reads), so the answer and the work it permits see the same moment; nothing is cached, so a
withdrawal takes effect on the next request. The two places that ask are creation endpoints, not hot paths. If
that changes, the cache belongs inside this service.

Two features are declared, because two are enforced: `imports` and `exports`, at the endpoints that create a
job (`POST /imports`, `POST /exports`). The check comes before the idempotent replay, so a withdrawn feature
starts no new job, even a repeated one. **A feature is added to the list in the change that adds its check,
never before**: a declared feature that is not enforced is a promise the API does not keep.

### 5. What a plan can never withhold

Rights the law gives a person over their own data (access, export of one's own data, erasure, the data-rights
module) are not features and never will be. `exports` is the business export of a list view (MVP_SPEC M8), not
the data-rights export of a person. A test keeps feature names away from that vocabulary.

### 6. The operator command

`pnpm tenant:entitlements` (or `node dist/cli/entitlements-main.js`): `features`, `show`, `plan`, `grant`,
`revoke`, `clear`, each naming the workspace by its id (which `tenant:create` prints) or its slug. A plan the catalogue does not know is refused; an
exception needs a reason; on a single-tenant installation an exception is refused as pointless rather than
accepted and ignored.

## Alternatives considered

- **Catalogue in the database.** See §2; deferred, not rejected.
- **Overrides in `tenants.settings` (jsonb).** Written by `crm_app` (an administrator edits settings), so a
  workspace could grant itself a feature. Rejected for exactly that reason.
- **A new `crm_operator` role.** Cleaner naming, but a bootstrap change on every deployment for no new capability.
- **A platform-admin HTTP endpoint.** There is no platform-admin identity, and creating one is a security
  decision of its own (who authenticates it, how it is audited). The command needs none.
- **Limits (seat counts, record caps).** ADR-0010 wants them as values. None is declared, because enforcing one
  needs a pricing decision the founder has not made, and an unenforced limit misleads. The table takes a new
  column when the first one arrives.

## Consequences and limits

- **No audit trail of changes.** An override carries its reason and its last-changed time, but a cleared or
  replaced override leaves no history. The audit log is written by the application role and is append-only to
  it, so the operator role cannot add to it. A change history (an append-only table the operator role may only
  insert into) is the next step if more than one person operates an installation.
- **The web app does not yet adapt.** A screen shows an import or export button to a workspace that lacks the
  feature; pressing it gets a 402 and a message. Hiding it is cosmetic and needs an endpoint that returns the
  workspace's features; it is not here.
- **Work already queued runs.** A job accepted before a feature is withdrawn is completed by the worker, and an
  export already produced can still be downloaded. Withdrawal stops new work, not a person's access to what was
  made.
- Switching an installation to `single_tenant` makes every override inert; they are kept, and apply again if it
  is ever switched back.
