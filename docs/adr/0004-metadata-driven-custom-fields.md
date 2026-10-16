# ADR-0004: Standard tables plus `custom_fields jsonb` plus `field_definitions`

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Every business wants fields we did not anticipate. The two classic answers both
fail at our targets: a fully generic Entity-Attribute-Value model makes every list
query a multi-join and destroys the p95 < 200 ms budget (MVP_SPEC §9), while fixed
columns alone mean a migration per customer request.

## Decision

Standard objects (Account, Contact, Lead, Deal) are **real tables with real columns**
for the fields every CRM has, plus a `custom_fields jsonb` column with a **GIN index**.

Custom fields are declared in a `field_definitions` table
(`object_type, key, label, type, options, required, validation, position, ...`) and
validated on every write in `@crm/core/fields`.

**Code must never assume a fixed field list.** List views, forms, filters, sorting,
import and export all read field metadata. A hardcoded column list anywhere in the
UI or API is a bug.

Filterable custom fields get **expression indexes created on demand**, so a tenant
that filters heavily on one custom field gets an index for it without every tenant
paying for every field.

## Consequences

- Standard fields keep native column types, constraints and index performance.
- Custom fields ship without a migration.
- Validation must be driven by metadata, which is more code than static DTOs; the
  payoff is that the same engine serves custom objects in P2.
- Queries that filter on `custom_fields` need care to stay index-eligible.
- A generic `records` table for **custom objects** (P2) can be added later without
  touching standard objects, because the metadata engine already exists.

## Alternatives considered

- **EAV for everything.** Rejected: query cost and loss of type safety.
- **Fixed columns only.** Rejected: a migration per customer request does not scale
  to "any business" (MVP_SPEC §1).
- **A spare-column pool.** Rejected: hard caps, type confusion, and the schema then
  lies about what the data means.
