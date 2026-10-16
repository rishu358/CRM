# ADR-0005: Polymorphic links `(object_type, record_id)`

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Notes, activities, tags, attachments and the timeline must attach to Contacts,
Accounts, Leads and Deals today — and to custom objects in P2 (MVP_SPEC §3). A
separate `contact_notes` / `account_notes` / `deal_notes` table per pairing
multiplies the schema and guarantees that adding an object means touching every
one of those features.

## Decision

Linking tables use a **polymorphic pair**: `object_type text NOT NULL` plus
`record_id uuid NOT NULL`, alongside the mandatory `tenant_id`.

This applies to `activity_links`, `record_tags`, `attachments`, `timeline_events`
and anything similar added later.

`object_type` is constrained to a known set in `@crm/core`, and indexes are
`(tenant_id, object_type, record_id)`.

## Consequences

- Adding an object type costs nothing in these features.
- **We give up database-level foreign keys** on the polymorphic side. Referential
  integrity becomes the service layer's job, and orphan cleanup is a worker task
  driven by delete events (ADR-0006). This is the real price of the decision and
  must not be forgotten.
- Joins to the parent record cannot be expressed generically in SQL; the service
  resolves the target table from `object_type`.

## Alternatives considered

- **A link table per object pair.** Rejected: combinatorial schema growth, and every
  new object means editing every feature.
- **Nullable FK columns per type.** Rejected: keeps foreign keys, but requires a
  schema migration and a new nullable column for every object added, including every
  custom object in P2.
