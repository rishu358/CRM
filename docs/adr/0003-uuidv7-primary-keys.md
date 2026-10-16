# ADR-0003: UUIDv7 primary keys

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Sequential integer keys leak business volume and invite enumeration attacks
(`/contacts/1`, `/contacts/2`, and so on). Random UUIDv4 keys fix that but scatter
B-tree inserts across the index, causing page splits and poor cache locality —
measurable at 1M records per tenant (MVP_SPEC §9).

## Decision

**UUIDv7** for every primary key. UUIDv7 embeds a millisecond timestamp in its
leading bits, so values are time-sortable while the trailing bits stay random.

IDs are generated in the **application** (`@crm/core/ids`), not the database, so a
record's identity exists before insert — needed to build the outbox event and audit
entry inside the same transaction.

## Consequences

- Index inserts stay append-like: no enumeration, near-sequential locality.
- `(created_at, id)` keyset pagination (ADR-0012) gets a stable, meaningful tiebreak.
- IDs are sortable by creation time, which leaks an approximate creation timestamp.
  Accepted: `created_at` is already visible on every record we expose.
- Generation lives in exactly one module; nothing else may mint IDs.

## Alternatives considered

- **bigserial.** Rejected: enumerable, leaks volume, unsafe to merge across shards.
- **UUIDv4.** Rejected: index fragmentation at our target scale.
- **ULID.** Equivalent properties, but UUIDv7 is an IETF standard stored natively in
  the Postgres `uuid` type, with broader tooling support.
