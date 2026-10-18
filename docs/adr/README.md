# Architecture Decision Records

One record per decision that would be expensive to reverse (CLAUDE.md §11.7).

Records are immutable once merged. To change a decision, add a new ADR that
supersedes the old one and update the old one's **Status** to
`Superseded by ADR-XXXX`.

| #                                                       | Decision                                                        | Status   |
| ------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                        | Modular monolith                                                | Accepted |
| [0002](0002-shared-db-tenant-id-rls.md)                 | Shared database, `tenant_id` + Postgres RLS                     | Accepted |
| [0003](0003-uuidv7-primary-keys.md)                     | UUIDv7 primary keys                                             | Accepted |
| [0004](0004-metadata-driven-custom-fields.md)           | Standard tables + `custom_fields jsonb` + `field_definitions`   | Accepted |
| [0005](0005-polymorphic-record-links.md)                | Polymorphic links `(object_type, record_id)`                    | Accepted |
| [0006](0006-transactional-outbox.md)                    | Transactional outbox + domain events                            | Accepted |
| [0007](0007-api-first-versioned-rest.md)                | API-first, versioned `/api/v1`, OpenAPI                         | Accepted |
| [0008](0008-central-policy-engine.md)                   | Central policy engine `can()`                                   | Accepted |
| [0009](0009-provider-interfaces.md)                     | Provider interfaces for all vendors                             | Accepted |
| [0010](0010-entitlements-and-feature-flags.md)          | Entitlements + feature flags                                    | Accepted |
| [0011](0011-i18n-currency-timezone-from-day-one.md)     | i18n, multi-currency, time zones from day one                   | Accepted |
| [0012](0012-keyset-pagination.md)                       | Keyset pagination everywhere                                    | Accepted |
| [0013](0013-data-region-on-tenant.md)                   | Data region field on tenant                                     | Accepted |
| [0014](0014-self-hosted-auth.md)                        | Self-hosted auth (Better Auth) in our DB                        | Accepted |
| [0015](0015-toolchain-version-pinning.md)               | Toolchain pinned to the type-aware-lint-compatible set          | Accepted |
| [0016](0016-explicit-dependency-injection-tokens.md)    | Explicit `@Inject` tokens on every injected parameter           | Accepted |
| [0017](0017-better-auth-as-primitives-not-framework.md) | Better Auth as primitives, not as the session framework         | Accepted |
| [0018](0018-account-hierarchy-integrity.md)             | Account hierarchy integrity enforced in the database            | Accepted |
| [0019](0019-invitation-acceptance-identity.md)          | Invitation acceptance identity, and where its token lives       | Accepted |
| [0020](0020-deal-stage-transitions.md)                  | The stage decides whether a deal is closed                      | Accepted |
| [0021](0021-currency-conversion-seam.md)                | Currency conversion behind an exchange-rate source              | Accepted |
| [0022](0022-lead-conversion.md)                         | A lead converts once, in one transaction, onto records it names | Accepted |
| [0023](0023-duplicate-detection.md)                     | What "duplicate" means, and who is allowed to be told           | Accepted |
| [0024](0024-rich-text-sanitization.md)                  | Rich text: an allow-list, applied on write and on read          | Accepted |
| [0025](0025-reminder-and-digest-scheduling.md)          | Reminders and digests are scheduled by the outbox               | Accepted |
| [0026](0026-activity-ownership-is-the-assignee.md)      | An activity's owner is its assignee                             | Accepted |
| [0027](0027-openapi-generated-from-contracts.md)        | OpenAPI generated from the Zod contracts, with a drift test     | Accepted |
| [0028](0028-global-search-index.md)                     | Global search: a per-field index behind a provider interface    | Accepted |
