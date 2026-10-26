# ADR-0034: Reading the audit log, and emptying the Recycle Bin

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

MVP_SPEC M11 asks for an audit log viewer for administrators, filtered by user,
object and date, and exportable. MVP_SPEC M4 asks that a soft-deleted record be
restorable for 30 days and then hard-deleted by a job.

Both are straightforward features with one hard constraint each, and the
constraints are not the ones that look hardest.

**The audit log is the largest table in the database.** Every create, update,
delete, login, export, permission change and import of every record of every
tenant writes a row. It is partitioned monthly by `occurred_at` (migration 0003)
precisely so that an old month can be detached rather than deleted. A viewer
over it is therefore not "a list endpoint like the others": the difference
between a filter that lands on the partition key and one that does not is the
difference between reading one month and reading every month a tenant has.

**The purge job needs a schedule, and this system has no cron.** ADR-0025
established that recurring work is an outbox row dated to when it is due, with
the handler arming the next one — because that survives a restart, needs no
coordination between worker processes, and does not sweep across tenants. The
Recycle Bin purge has to fit that model or break it.

A third thing is settled here because it is where people will look for it: the
Recycle Bin's **restore** path, and what a soft delete leaves behind.

## Decision

### 1. Every audit query is bounded in time

`from` and `to` are part of the contract and **default to the last 30 days**
(`AUDIT_DEFAULT_WINDOW_DAYS` in `@crm/core`), rather than being optional filters
over an unbounded default. The repository always emits both as literal bounds on
`occurred_at`, so the planner can prune to the partitions that can contain the
range.

A caller who wants more asks for it and pays for it knowingly. The alternative —
an open-ended default — is an endpoint that is correct, passes every test, and
falls over on the first customer with four years of history.

`packages/db/src/audit-query.perf.spec.ts` asserts the plan: a bounded window
opens at most two monthly partitions, an unbounded one opens many (the negative
case, so that if pruning ever started happening by itself somebody finds out
from a test), and each filter reaches an index rather than scanning a partition.

### 2. Two more indexes, and the recipe for adding a third

0003 indexes `(tenant_id, occurred_at)`, `(tenant_id, actor_id, occurred_at)` and
`(tenant_id, object_type, record_id)` — "who did this" and "the history of this
record". Migration 0016 adds `(tenant_id, object_type, occurred_at)` and
`(tenant_id, action, occurred_at)`, which are the viewer's other two filters
combined with a range.

`CREATE INDEX` on a partitioned table recurses and locks each partition, and
`CONCURRENTLY` cannot run inside the transaction a migration is. That is
acceptable in 0016 because the index is built per month and only the current
partition holds many rows. **At real volume the recipe is:**

```
CREATE INDEX ... ON ONLY audit_logs (...);            -- instant, marked invalid
CREATE INDEX CONCURRENTLY ... ON audit_logs_2027_03 (...);   -- one per partition,
ALTER INDEX ... ATTACH PARTITION ...;                        -- outside a transaction
```

and the rolling-window job that creates next month's partition should create its
indexes at the same time, while it is empty. Written down here so the next
person adding an index to this table does not have to work it out from a locked
production database.

### 3. The viewer requires `all` scope, and nothing narrower

Reading history needs `read` on the `audit_log` object type — a capability
granted as a row like everything else (ADR-0008), seeded to Owner and Admin.
A grant at `own` or `team` scope is **refused**, not silently treated as `all`.

An audit row has no owner. Resolving "whose record was this about" would mean
joining to five tables for records that may since have been purged, and would
still not answer it for a row about a session or an invitation. A half-working
scope is worse than a refusal that says what is wrong, so `AuditLogService`
refuses with a message naming the problem.

Record permissions still apply in one direction: a reader sees no rows about a
business object type they have no `read` grant on. Holding the audit capability
is permission to read _history_, not a way to recover access to an object a role
was deliberately not given.

### 4. The Recycle Bin is read one object type at a time

`GET /recycle-bin` requires `objectType`. A single merged list across the five
soft-deletable tables was the obvious shape and is the wrong one: keyset
pagination needs a total order over the rows it pages through (ADR-0012), and
`(deleted_at, id)` across five independently indexed tables cannot be read in
that order without sorting the union in memory or paging each table separately
and interleaving. Both give up the property the cursor exists to provide.

Per-table partial indexes over `deleted_at IS NOT NULL` (migration 0016) keep the
Bin's two queries — "what can I restore" and "what is past retention" — off every
live row.

### 5. Restore re-checks permission, and is a versioned write

Restoring requires `delete` on the object type **now**, and the record must be
inside the actor's scope **now**. It does not inherit the right from whoever
deleted it: a rep whose access was narrowed, or whose team changed, cannot pull a
record back into view that they could no longer see.

`delete` rather than `update`, because restoring is the inverse of deleting and
the permission model already has that verb for "this record's existence is mine
to decide".

It carries `version` like every other write, so restoring a record that has moved
since the Bin was listed is a 409 rather than a silent overwrite, and it emits an
audit entry and a `<object>.restored.v1` event in the same transaction — which is
what puts the record back into search and the timeline, through the handlers that
already exist.

### 6. The purge is an outbox row that re-arms itself

One `recycle_bin.sweep_due.v1` per tenant, dated 24 hours out, armed at
provisioning and re-armed by its own handler in the same transaction as the work.
A partial unique index on `outbox_events (tenant_id, event_type) WHERE
event_type = '…' AND status = 'pending'` makes arming idempotent: a redelivery,
a concurrent write and the migration's backfill cannot between them queue two.
The index covers `pending` only, which is what lets the sweep currently being
processed arm its successor.

**Rejected: one event per deleted record**, dated to `deleted_at + 30 days`. It
is simpler and precise, and it is the wrong shape at scale — a bulk delete of
50,000 contacts would leave 50,000 rows sitting in the relay's pending index for
a month. One row per tenant is a thousand rows for the whole platform.

When a sweep fills its batch it arms the next one in a minute rather than
tomorrow, so a tenant that deleted a hundred thousand records is not rid of them
in a hundred thousand days. If the relay gives up on a sweep entirely, an
exhaustion hook re-arms it an hour out — without that, a single permanent
failure would stop that tenant's Bin emptying for ever.

### 7. The purge cleans up in its own transaction

A soft delete deliberately **keeps** the rows that point at a record —
`activity_links`, `record_tags`, `timeline_events`, `record_views` — because a
restored contact should come back with its tasks and its history attached. That
is already how `pruneActivityLinks` behaves: it reacts to the delete event and
does nothing while the row is still there.

Purging is the moment they stop being worth keeping, and the purge removes them
**in the same transaction** as the record. They are not side effects to be
announced through the outbox: they are rows in the same database that would
otherwise reference a row that no longer exists, and a crash between the two
would leave exactly that. The search index is cleared here too, defensively —
the soft delete already removed it, but a record purged after an index rebuild is
the one case where a stale row would survive everything else.

`<object>.purged.v1` is published for anything that _cannot_ be cleaned up
transactionally because it lives outside this database. **Record attachments are
that case and are not built yet**: when they arrive, a handler subscribed to
`purged.v1` deletes the stored bytes. It does not get added to the in-transaction
table list.

## Consequences

- An audit query without a date range is impossible through the API. A client
  that genuinely needs the whole history pages through it a window at a time.
- Adding an index to `audit_logs` later needs the ON ONLY / CONCURRENTLY /
  ATTACH recipe above, and a migration that does it the simple way will lock a
  large table. The recipe is written down rather than rediscovered.
- A custom "Auditor" role is possible today — `audit_log:read` at `all` plus
  `read` on whichever objects it should cover — without a deploy.
- The Recycle Bin's UI is tabbed, because the API is. That is a product
  consequence of a pagination decision and is worth saying out loud.
- The purge chain depends on exactly one pending sweep per tenant. The partial
  unique index is what guarantees it; dropping that index would let duplicates
  accumulate silently.
