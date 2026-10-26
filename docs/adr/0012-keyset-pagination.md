# ADR-0012: Keyset pagination everywhere

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

`OFFSET` pagination degrades linearly: the database must scan and discard every
skipped row. At 1M records per tenant (MVP_SPEC §9), deep pages take seconds, which
breaks the p95 < 200 ms budget. `OFFSET` also **skips and duplicates rows** when the
underlying data changes between page requests — a correctness bug, not just a
performance one.

## Decision

**Cursor-based (keyset) pagination only** on every list endpoint.

- The sort key is `(created_at, id)` by default. `id` is UUIDv7 (ADR-0003), so the
  pair is unique and stable, which guarantees a total order and a deterministic
  tiebreak.
- The cursor is an **opaque, encoded** value — clients must not construct or parse it.
- `limit` is capped at 100 (CLAUDE.md §8).
- Sortable fields are **whitelisted against field metadata** and translated into the
  keyset predicate; they are never interpolated into SQL (CLAUDE.md §5.7).
- Indexes exist for every `(tenant_id, <sort column>, id)` combination we allow.

## Consequences

- Page cost is flat regardless of depth, and infinite scroll never skips or repeats.
- **No "jump to page 47".** The UI uses infinite scroll and filtering instead. This
  is a real product constraint we accept.
- Total counts are expensive and are therefore approximate or omitted; where an exact
  count is needed it is a separate, explicitly budgeted query.
- Every new sortable field needs a matching composite index.

## Alternatives considered

- **OFFSET/LIMIT.** Rejected: fails both the latency budget and correctness under
  concurrent writes.
- **Cached page offsets.** Rejected: complex invalidation, still wrong under writes.
