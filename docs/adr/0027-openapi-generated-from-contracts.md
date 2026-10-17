# ADR-0027: OpenAPI generated from the Zod contracts, with a drift test

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

ADR-0007 made the API the product: one versioned REST surface at `/api/v1`, with
the web app as just another client, so that a mobile app, a public API and
Zapier launch with no new server work. It also said OpenAPI would be **generated
from the schemas, never hand-written**. CLAUDE.md §2 names it in the stack and
§12 lists "OpenAPI updated" in the Definition of Done.

Seven modules and sixty-five endpoints shipped without it. No document existed
anywhere in the repository — not generated, not committed, not served. ADR-0007's
promise was therefore unverifiable: nothing described the surface a third party
was supposed to reuse.

The obvious fix — write a document — fails in a way that is worse than having
none, because a document that silently disagrees with the server is a bug report
from an integrator rather than a failing build.

## Decision

**Generate the document from the Zod contracts, and make disagreement a failing
test.**

1. **A route registry** in `packages/contracts/src/routes.ts`: one entry per
   endpoint, naming the schemas that validate its params, query and body, the
   shape of its success response, and the error codes particular to it. It lives
   beside the schemas it points at so the two move together.

2. **A generator** in `packages/contracts/src/openapi.ts` that assembles an
   OpenAPI 3.1 document: the `{ data, meta }` success envelope and the
   `{ error: { code, message, details, requestId } }` failure envelope from
   CLAUDE.md §8, a shared `ErrorResponse` component, one error response per HTTP
   status listing the codes that produce it, and `/api/v1` as the server base.

3. **Served** at `GET /api/v1/openapi.json`, and **written to `docs/openapi.json`**,
   which is tracked so an API change shows up in review as a diff.

4. **A drift test** — `apps/api/src/openapi/route-drift.spec.ts` — that boots the
   real application, collects the routes Fastify has actually registered through
   an `onRoute` hook, and fails when they and the registry disagree **in either
   direction**: an endpoint with no entry, or an entry with no endpoint.

5. **A staleness test** — `packages/contracts/src/openapi.spec.ts` — that fails
   when `docs/openapi.json` differs from a fresh generation, plus
   `pnpm openapi:check` in CI for a faster answer.

The drift test is the decision. The document is a by-product.

### No new dependency

Zod 4 ships `z.toJSONSchema`, and OpenAPI 3.1 uses JSON Schema 2020-12, so the
schema half needs nothing outside the CLAUDE.md §2 stack table. Neither half of
this is a hand-written description of anything.

### Input and output are converted separately

A schema with `.transform()` — the email fields that lowercase, the boolean
query parameters that coerce — has no single JSON Schema: what a client sends
and what the server ends up with differ, and Zod refuses to convert such a
schema in `output` mode. Rather than removing the transforms, requests are
converted in `input` mode and responses in `output` mode, which is also what
each side of the document actually means. Nothing in `packages/contracts` was
weakened to make generation work.

`.refine()` predicates are dropped, because JSON Schema cannot express "these
two query parameters must be given together". Those rules are stated in prose on
the operation and enforced by the API regardless.

### The document is public

`GET /api/v1/openapi.json` is reachable without a session. An integrator reads
the spec before they have credentials, which is the premise of ADR-0007; the
document is generated from `packages/contracts`, which holds no secret, no
configuration and no tenant data; and it describes only the shape of a surface
the web bundle already names. The `openapi.spec.ts` suite asserts that no
environment value or connection string reaches the output, and `route-drift.spec.ts`
asserts the endpoint stays reachable and stays clean, so making it private
later — or letting it leak more — would be a deliberate edit rather than a drift.

It is also the one response in the API that is **not** wrapped in the
`{ data, meta }` envelope: every OpenAPI tool expects the document itself at
this path, and wrapping the one artifact whose job is to be machine-readable
would make it the one thing no machine could read.

### The document is never a source of truth

It is generated from contracts that already exist and is never read at request
time. Authentication, tenancy and permissions are enforced where they always
were — the guards, the services, the serializers. **An endpoint must never be
written against this document or against the registry.** The registry describes;
it does not decide. The drift test enforces the direction of that dependency:
it reads the real routing table and holds the registry to it, not the reverse.

## Consequences

- An endpoint added without a registry entry fails the build, so the document
  cannot quietly stop describing the API.
- An endpoint removed or renamed without updating the registry fails too, so the
  document cannot describe endpoints that no longer exist.
- A changed request or response shape produces a `docs/openapi.json` diff in the
  pull request that caused it, where a reviewer sees it.
- The registry is one more file to touch when adding an endpoint. That is the
  cost, and it is paid once per endpoint rather than once per integration.
- Three controller-local query schemas (`sessionRevokeQuerySchema`,
  `googleCallbackQuerySchema`, `invitationAcceptQuerySchema`) moved into
  `packages/contracts`, where the rest already were. Behaviour is unchanged; they
  were the only request shapes the contracts package could not see.

## Alternatives considered

- **`@nestjs/swagger` decorators.** Rejected: it is a second description of every
  request and response, written by hand next to the Zod schema that already says
  the same thing, and nothing makes the two agree. It also adds a dependency
  outside the §2 stack table to solve a problem Zod already solves.
- **A hand-written document.** Rejected for the reason this ADR exists.
- **Generating from the running server's route table alone.** Rejected: it gives
  paths and methods but no schemas, so it could not describe a single body. It is
  used for what it is good at — proving the registry is complete.
- **Trusting the registry without a drift test.** Rejected: that is the failure
  mode that produced this debt in the first place.
