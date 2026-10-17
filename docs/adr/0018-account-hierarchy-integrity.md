# ADR-0018: Account hierarchy integrity in the database

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

`accounts.parent_account_id` references `accounts.id`. It is the first
self-referencing column in the schema, and it brings two problems that no
column before it has had.

**A cycle is not a bad value, it is a hang.** If A is the parent of B and B is
the parent of A, every walk of the hierarchy runs forever: a rollup of
subsidiary revenue, a breadcrumb on the record page, a tree in an export, a
`WITH RECURSIVE` query written a year from now by somebody who assumed the data
was a tree. Unlike a malformed phone number, nothing degrades gracefully — the
request does not return. The code that suffers has not been written yet, which
is exactly why the invariant has to hold before it is.

**A foreign key to `accounts (id)` does not mean "in this tenant".** Row-Level
Security decides which rows a query can _see_; referential integrity checks run
with row security off, because they must. So RLS has nothing to say about a
value that _points at_ another tenant's row. A caller who came by an account id
from another company — and ids are UUIDv7, so this is unlikely rather than
impossible — could have stored it in `parent_account_id`. Nothing would leak,
since reading the parent still goes through the scope check, but a table we
promise is tenant-isolated would hold a permanent cross-tenant reference, and
the first join written against it would be a breach.

There is also a product question with no obvious answer: what happens to the
children when a parent is soft-deleted?

## Decision

### 1. The same-tenant rule is a composite foreign key

`accounts` gains `UNIQUE (tenant_id, id)`, and the parent key becomes

```sql
FOREIGN KEY (tenant_id, parent_account_id) REFERENCES accounts (tenant_id, id)
  ON DELETE SET NULL (parent_account_id)
```

Because `tenant_id` is `NOT NULL`, the pair is always checked when a parent is
set, and a parent in another tenant simply cannot be stored. The column list on
`ON DELETE SET NULL` is required — without it Postgres would try to null
`tenant_id` as well, and a hard delete of a parent would fail.

### 2. Cycles are refused by a trigger, not only by the service

`accounts_assert_no_parent_cycle()` runs `BEFORE INSERT OR UPDATE OF
parent_account_id`, walks the proposed parent's ancestors with a recursive CTE,
and raises `check_violation` with the constraint name
`accounts_parent_cycle` if the row being written is among them. Self-parenting
is caught by a plain `CHECK` alongside it.

The trigger takes `pg_advisory_xact_lock` on `(accounts.parent_account_id,
tenant_id)` **before** it walks. This is the part that is easy to omit and
impossible to notice: without it, two concurrent transactions — one setting A's
parent to B, the other setting B's parent to A — each walk a snapshot in which
the other's change does not exist, both find no cycle, and both commit. With
it, hierarchy changes serialise per tenant, and because a PL/pgSQL statement
takes a fresh snapshot under READ COMMITTED, the walk that runs after the lock
is released sees the change that was holding it. Parent changes are rare, so
the contention costs nothing.

`AccountsService` performs the same check first, and translates the trigger's
refusal into the module's `VALIDATION_FAILED` envelope. The service check exists
to produce a sentence a user can act on; the trigger is the guarantee.

### 3. Soft-deleting a parent leaves its children pointing at it

Deleting an account with children is allowed, and the children keep their
`parent_account_id`. A soft-deleted parent is invisible to every read, so the
hierarchy simply stops there until it is restored, at which point it is whole
again. A deleted account also cannot be _chosen_ as a parent.

## Consequences

- The hierarchy is a forest at all times, enforced by the database, so a
  recursive query written later is safe by construction rather than by
  convention.
- Any future write path — CSV import, a merge tool, a bulk reassign — inherits
  both rules without asking, which is the point of putting them here.
- The service's ancestor walk is tenant-scoped but **not** record-scoped. A rep
  with `own` scope can file their account under a parent they cannot read, which
  is necessary (the group company usually belongs to a manager) and deliberate:
  the reference is accepted, but reading the parent still goes through `can()`,
  and the error for a parent in another tenant is byte-identical to the one for
  an id that does not exist, so the field is not an existence oracle.
- The advisory lock serialises parent changes per tenant. At the volume of
  hierarchy edits a CRM sees, this is free; a bulk importer that reparents
  thousands of accounts would want to know about it.
- `ON DELETE SET NULL` applies only to a **hard** delete, which today happens
  only in the Recycle Bin purge job that has not been built. When it is, it has
  to purge children before parents or accept the orphaning this clause does.

## Alternatives considered

- **Service-level check only.** Rejected: it cannot survive an import, a seed
  or a future code path, and the concurrent case needs a database lock anyway —
  at which point most of the trigger already exists.
- **Cascade the soft delete to children.** Rejected: deleting a group company
  would silently remove every subsidiary from every list, and the Recycle Bin
  would have to know which children were deleted _because of_ the parent in
  order to restore them correctly.
- **Null the children's `parent_account_id` on delete.** Rejected: it destroys
  the hierarchy irreversibly, inside a feature whose entire promise is that a
  delete can be undone within 30 days.
- **Refuse to delete a parent that has children.** Rejected: it makes a group
  company undeletable until somebody reparents every branch by hand, and offers
  no path for the common case of closing down a whole group.
- **A materialised path or closure table.** Rejected for now: both make reads
  cheaper and writes more complicated, and nothing reads the hierarchy deeply
  yet. The constraint above is what makes adding one later safe.
