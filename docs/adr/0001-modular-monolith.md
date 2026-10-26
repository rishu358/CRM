# ADR-0001: Modular monolith

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The platform must be buildable by a very small team now, yet survive 1,000 tenants
and a decade of feature growth (CLAUDE.md §1). Microservices from day one would
multiply deployment, tracing, transaction and local-development cost before there
is any scale to justify it. A single unstructured application, on the other hand,
becomes impossible to split once module boundaries have rotted.

## Decision

Build **one deployable API** (`apps/api`) composed of strictly bounded modules under
`apps/api/src/modules/<module>/`, each with `controller`, `service`, `repository`,
`dto`, `events`.

Modules communicate **only** through:

1. another module's **service** public methods, or
2. **domain events** published to the transactional outbox (ADR-0006).

A module may never import another module's repository, nor query another module's
tables directly. This is the invariant that makes extraction possible later.

## Consequences

- One process to run, one transaction boundary, trivial local development.
- Extracting a module into its own service later means replacing in-process service
  calls with network calls and its event subscriptions with a broker topic — a
  mechanical change, not a redesign.
- The boundary is not enforced by the runtime, so it must be held by review and
  lint rules. Violations are cheap to introduce and expensive to unwind.

## Alternatives considered

- **Microservices now.** Rejected: operational cost with no scale to justify it, and
  distributed transactions would complicate the audit/outbox guarantees we need.
- **Unstructured monolith.** Rejected: no path to extraction; boundaries decay silently.
