# ADR-0007: API-first, versioned `/api/v1`, OpenAPI generated from code

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

A mobile app, a public API, Zapier and partner integrations are all on the roadmap
(MVP_SPEC §12). If the web app talks to private endpoints with privileged behaviour,
every one of those consumers becomes a second implementation of the same logic, and
the private path becomes the one that is less carefully authorized.

## Decision

- **One versioned REST API** at `/api/v1`. The web app is just another client of it.
  There are **no hidden internal endpoints**.
- Request and response schemas live in `packages/contracts` as **Zod schemas**,
  shared by API and web, so the two cannot drift.
- **OpenAPI is generated from those schemas**, never hand-written.
- Within a version, only **additive** changes. Anything breaking requires `/api/v2`.
- Conventions: plural nouns, a `{ data, meta }` envelope, `{ error: { code, message,
details, requestId } }` for failures with stable machine-readable codes, and an
  `X-Request-Id` header on every response.

## Consequences

- Every endpoint is authorized exactly once, on the only path that exists.
- Mobile and the public API launch with no new server work.
- The web app cannot take shortcuts, such as a bulk endpoint shaped for one screen;
  features must be expressed in terms a third party could also use.
- Versioning discipline becomes permanent overhead: additive-only is a real constraint.

## Alternatives considered

- **GraphQL.** Rejected for MVP: per-field authorization and query-cost limiting are
  substantial extra work, and REST matches the integration ecosystem (Zapier,
  webhooks) we are targeting.
- **Private BFF endpoints for the web app.** Rejected: duplicates logic and creates a
  second, less scrutinised authorization surface.
