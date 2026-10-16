# ADR-0013: Data region recorded on the tenant

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

India's DPDP Act, the GDPR and several enterprise procurement processes impose data
residency requirements. MVP runs in a single region, but the first customer who
demands EU or US residency must not trigger a schema change across every table.

## Decision

`tenants.region` is recorded from day one, even though MVP has exactly one region.

The application reads the region when resolving which database and object-storage
bucket to use, through a `tenant_router` indirection that today always returns the
single default connection.

Presigned storage URLs and outbound email are issued from the tenant's region.

## Consequences

- Adding a region later means deploying infrastructure and teaching the router about
  it, rather than migrating the data model.
- `region` is immutable once set; moving a tenant between regions is an explicit,
  audited migration operation, never an update.
- A small amount of indirection exists in MVP that appears to do nothing. That is the
  point: it is the seam.
- Cross-region platform reporting will need to aggregate across connections. Accepted
  as future work.

## Alternatives considered

- **Add the column when a customer asks.** Rejected: by then there is production data
  and the backfill touches every tenant-scoped assumption in the codebase.
- **Region per record.** Rejected: residency is a property of the customer, not of the
  row, and per-row routing would make every query a distributed query.
