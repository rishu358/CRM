# Architecture Decision Records

One record per decision that would be expensive to reverse (CLAUDE.md §11.7).

Records are immutable once merged. To change a decision, add a new ADR that
supersedes the old one and update the old one's **Status** to
`Superseded by ADR-XXXX`.

| #                                                   | Decision                                                      | Status   |
| --------------------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                    | Modular monolith                                              | Accepted |
| [0002](0002-shared-db-tenant-id-rls.md)             | Shared database, `tenant_id` + Postgres RLS                   | Accepted |
| [0003](0003-uuidv7-primary-keys.md)                 | UUIDv7 primary keys                                           | Accepted |
| [0004](0004-metadata-driven-custom-fields.md)       | Standard tables + `custom_fields jsonb` + `field_definitions` | Accepted |
| [0005](0005-polymorphic-record-links.md)            | Polymorphic links `(object_type, record_id)`                  | Accepted |
| [0006](0006-transactional-outbox.md)                | Transactional outbox + domain events                          | Accepted |
| [0007](0007-api-first-versioned-rest.md)            | API-first, versioned `/api/v1`, OpenAPI                       | Accepted |
| [0008](0008-central-policy-engine.md)               | Central policy engine `can()`                                 | Accepted |
| [0009](0009-provider-interfaces.md)                 | Provider interfaces for all vendors                           | Accepted |
| [0010](0010-entitlements-and-feature-flags.md)      | Entitlements + feature flags                                  | Accepted |
| [0011](0011-i18n-currency-timezone-from-day-one.md) | i18n, multi-currency, time zones from day one                 | Accepted |
| [0012](0012-keyset-pagination.md)                   | Keyset pagination everywhere                                  | Accepted |
| [0013](0013-data-region-on-tenant.md)               | Data region field on tenant                                   | Accepted |
| [0014](0014-self-hosted-auth.md)                    | Self-hosted auth (Better Auth) in our DB                      | Accepted |
| [0015](0015-toolchain-version-pinning.md)           | Toolchain pinned to the type-aware-lint-compatible set        | Accepted |
