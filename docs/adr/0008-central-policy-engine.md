# ADR-0008: Central policy engine `can(actor, action, resource)`

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Authorization scattered as inline role comparisons across controllers cannot be
audited, cannot be tested as a unit, and drifts the moment a new role appears.
MVP_SPEC §4 already needs five roles plus custom roles, with `own` / `team` / `all`
record scopes and field-level `hidden` / `read` / `write` access — and Phase 3 adds
territories and approval processes.

## Decision

One function, in `packages/core/permissions`, with the signature
`can(actor, action, resource)` returning a decision object.

- **Default deny.** An action with no matching grant is denied.
- Inputs are the actor's memberships, role permissions, field permissions and teams —
  never anything taken from the client (CLAUDE.md §5.2).
- Record scope (`own` / `team` / `all`) is returned as a **query constraint** that the
  repository applies, so scoping is enforced in SQL rather than by filtering rows
  after they have been fetched.
- **Field-level permissions are applied in the serializer**: hidden fields are
  stripped from responses and rejected on write.
- **No inline role checks anywhere.** This is enforced by a lint rule, not just review.

## Consequences

- Authorization becomes one testable unit with exhaustive unit tests, plus the four
  mandatory per-module security tests (CLAUDE.md §10).
- Attribute-based rules (territory, deal size) can be added inside `can()` later
  without touching a single endpoint.
- Every endpoint pays a `can()` call, so the engine must stay pure and fast, with the
  actor's permission set resolved once per request.
- `can()` becomes a single point of failure: a bug there is a platform-wide
  authorization bug. It gets the heaviest test coverage in the codebase.

## Alternatives considered

- **Inline role checks.** Rejected explicitly by CLAUDE.md §5.3.
- **An external policy engine such as OPA or Cedar.** Rejected for MVP: another
  runtime to operate, and the policy data lives in our database anyway. The `can()`
  signature is deliberately shaped so this swap stays possible.
