# ADR-0009: Provider interfaces for every external vendor

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

MVP needs email, object storage and search. Phase 2 adds WhatsApp and payments;
Phase 3 adds AI. Each of those choices is likely to change for reasons that have
nothing to do with product: cost, regional availability, or a compliance
requirement such as DPDP data residency (ADR-0013). If vendor SDK calls are
sprinkled through business logic, each swap becomes a refactor of the whole app.

## Decision

Every external capability sits behind an interface defined in `packages/core`:
`EmailProvider`, `StorageProvider`, `SearchProvider`, and later `SmsProvider`,
`PaymentProvider`, `AiProvider`.

**No vendor SDK may be imported outside its own adapter.** Business logic depends on
the interface only, and adapters are selected by configuration.

For MVP: Postgres full-text plus `pg_trgm` implements `SearchProvider` (Meilisearch
later), an S3-compatible client implements `StorageProvider`, and Resend or SES
implements `EmailProvider`. A console adapter backs local development.

## Consequences

- Swapping a vendor touches one adapter plus configuration.
- Tests use in-memory fakes of the interfaces, so no test needs network access.
- Interfaces must expose the **lowest common denominator** of what vendors offer, so
  a vendor-specific feature either goes unused or forces an interface change. This is
  the cost, and it is deliberate.
- One extra layer of indirection on every outbound call.

## Alternatives considered

- **Direct SDK calls.** Rejected: makes vendor choice irreversible in practice.
- **A generic integration framework.** Rejected: far more machinery than six
  interfaces justify.
