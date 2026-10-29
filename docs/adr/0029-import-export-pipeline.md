# ADR-0029: Import and export run in the worker, in idempotent chunks

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

MVP_SPEC M8 asks for CSV/XLSX import with column mapping, a preview, duplicate
handling, background processing and a downloadable error file; and for export
from any list view that respects filters and permissions and is audited. The
acceptance criterion is that importing 50,000 contacts "completes without
blocking the UI and reports created/updated/skipped/failed counts".

An import is the one path that creates records in bulk from a file a user
supplies, and an export is the one path that moves a whole customer list out of
the building. Three properties therefore matter more here than anywhere else, and
this ADR is mostly about the first:

1. **A retry must not double-create.** The outbox delivers at-least-once
   (ADR-0006). A worker that crashes after inserting 500 contacts and before
   recording that it did will be asked to do the same chunk again.
2. **Both are the permission model, run at volume.** Field permissions, record
   scope, `owner_id`, tenant isolation — each is a rule the module services
   already enforce one record at a time, and the bulk path must not be the place
   they stop applying.
3. **A hostile file must fail cleanly.** See ADR-0030 for the file-handling half.

## Decision

### 1. The worker does the work; the API only keeps the job

`POST /imports` creates a job and returns a presigned upload URL. The browser
uploads to object storage, then `POST /imports/{id}/uploaded` queues analysis.
`POST /imports/{id}/start` validates the mapping and queues the run. The API
never parses a file and never writes an imported record; a request handler that
created 50,000 contacts is exactly what the pipeline exists to avoid. Exports are
the same shape: `POST /exports` validates and queues, the worker writes the file
to storage, `POST /exports/{id}/download` returns a short-lived link.

### 2. An import is a chain of events, one per step

```
import.uploaded.v1  analyze   validate the bytes, read header + preview, count rows
import.started.v1   stage     re-validate, copy the rows into import_rows
import.chunk.v1     process   write 500 rows; queue the next chunk, or finish
```

Each handler runs inside the relay's tenant-scoped transaction, so its writes —
the records, their audit rows and outbox events, the error rows, the job's
checkpoint, **and the event that queues the next step** — commit together or not
at all.

That one property is the whole idempotency story:

- **Crash before commit.** Nothing happened. The relay backs the event off and
  retries; the retry starts from the same checkpoint.
- **Crash after commit, before `markRelayed`.** The step happened and the next is
  queued. The event is delivered again; the handler finds the job no longer at
  that step (`status`) or the checkpoint no longer at that offset
  (`processed_rows <> startRow`) and returns. Nothing is written twice.

The unit of idempotency is the **chunk**, not the row. There is no per-row dedup
table, and none is needed. `import_jobs` has a `CHECK` that
`created + updated + skipped + failed = processed_rows`, so a retry that
double-counted would fail loudly instead of reporting a wrong total.

### 3. Rows are staged, because XLSX has no random access

Re-parsing the file for each chunk would be quadratic and, for a workbook, would
mean inflating the archive a hundred times. The file is parsed once into
`import_rows` (ordinal, the row number the **user** sees, the cells) and each
chunk is an indexed range read. Staging happens at `start`, not at upload, so an
abandoned mapping screen costs no rows. Staged rows and error rows are deleted in
the transaction that ends the job: they are somebody's spreadsheet, and nothing
reads them afterwards.

### 4. The state machine is in the database

`import_jobs` has a trigger (`0012_import_export.sql`) that allows only these
edges and refuses any change to a finished job, any backwards move of the
checkpoint or a counter, and any change to the job's identity (`tenant_id`,
`object_type`, `storage_key`, `created_by`):

```
awaiting_upload -> analyzing -> awaiting_mapping -> staging -> processing -> completed
        \              \             \                  \           \
         `--------------`-------------`-> rejected       `--> failed `--> failed
```

The API and the worker both write that row, so the rule cannot live in either.
`rejected` means the file was refused (and says why); `failed` means the system
could not finish (and says so without a stack trace). **A job with some failed
rows is still `completed`**: partial success is the normal case for a real
spreadsheet, and the error file is how it is reported.

### 5. Failure and retry semantics

| What goes wrong                                                                     | What happens                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A row is invalid                                                                    | Recorded against its row; the chunk carries on. Never retried: retrying a bad value cannot fix it.                                       |
| The database rejects a batch insert                                                 | Retried **row by row**, each behind a savepoint, so one bad row costs one error line, not 500.                                           |
| The file is not what it claimed, or breaks a limit                                  | The job is `rejected` with a sentence for the user; the upload is deleted. Not retried.                                                  |
| A step throws (storage down, DB down)                                               | The relay retries with exponential backoff, up to its attempt ceiling, in a fresh transaction.                                           |
| The relay gives up on a step                                                        | The `onExhausted` hook marks the job `failed` and cleans up (§6).                                                                        |
| The importer loses `import`/`create`/`update`, a field write, or membership mid-run | Detected at the **next chunk** (permissions are re-read from the database every chunk); the job fails, and records already written stay. |

### 6. Giving up has to be someone's job

A job whose step keeps throwing must not sit in `processing` forever: the relay
abandons the **event**, and nothing else would ever notice the **job**. The first
version of this tried to mark the job failed from inside the handler on the last
attempt. It **deadlocks**: the job row is locked by the attempt's own
transaction, so a second connection waits on it forever. The relay now has an
`onExhausted(eventType, handler)` hook that runs _after_ the failing attempt has
rolled back and the event has been marked failed, in no transaction at all. The
import and export handlers register their cleanup there. A test drives it.

### 7. Every parse is a fully validating parse

A presigned PUT stays valid for minutes, and `put` can overwrite. Between
analysis and staging an uploader could replace the object with a different one of
the same size. So **both** steps run the whole of `openUpload` — size, magic
bytes, archive inspection, limits. There is no window in which an unchecked file
is parsed, and a test replaces the object between the two steps.

### 8. Permissions are re-derived by the worker, and applied per row

The worker rebuilds the `Actor` from the database with the same `loadActor` the
API uses (it moved to `@crm/db` so there is one definition of "may"). What it then
does, row by row:

- **Fields.** A mapped column is checked against `canWriteField` for every row
  that supplies a value; a hidden or read-only field fails the row (it is not
  silently dropped). A blank cell supplies nothing and needs no permission.
- **What a file can never set.** (`owner_id` may now be set by someone who may reassign records,
  and a contact's account may be linked, both by name; see ADR-0067.) `owner_id`, `tenant_id`, `id`, `version` and the
  audit columns are not in `IMPORTABLE_SYSTEM_KEYS` (an allowlist, so a column
  added tomorrow is not importable by default). Every imported record is owned by
  the importer. Lead `status = converted` is refused by the same contract schema
  the API uses. The row-level guard refuses an off-allowlist system field even
  if the mapping check is bypassed, because an _update_ patch built from a mapped
  `owner_id` would reassign a record.
- **Values.** System fields go through the API's own create schemas
  (`contactCreateSchema` etc.), custom fields through the schema generated from
  this tenant's metadata, so an import cannot hold a looser idea of a valid email
  or GSTIN than a form does.
- **Matching** (skip / update) only sees records inside the actor's read scope: a
  duplicate in a colleague's book is not a match, `update` cannot touch it, and
  `skip` cannot be used to learn it exists (the same choice ADR-0023 makes for
  lead duplicates). A row that matches several records is _not_ updated: it is
  reported, because guessing which was meant is how data gets corrupted.
- **Updates** change only the fields the file supplies, merge custom fields
  rather than replace them, never bump a version for a no-op, and are guarded by
  the record's version.
- **Audit and events.** One audit row and one outbox event per record, written in
  the chunk's transaction, tagged with the import job id.

### 9. Export is a list query run to completion

Same filter, sort and search as the list, same record-scope `WHERE`, columns from
field metadata ∩ `canReadField` (a hidden field has **no column**, not an empty
one). Keyset paged, streamed to storage; never OFFSET, never the whole file in
memory. Audited three times: when requested (with the filters), when finished
(with the row count), and each time a link is issued.

The export's filter/sort SQL is a **copy** of what each module's `sql-helpers.ts`
builds, because the worker cannot import the API (§Consequences). It lives in
`@crm/db` (`planQuery`), and `exports.parity.security.spec.ts` runs the same
filters, sorts, searches and scopes through the real list endpoint and through it,
comparing exact ordered ids across page boundaries and the sets of accepted keys.

### 10. Side effects do not set the pace

500 imported records write 500 outbox events (search indexing, timeline). The next
chunk's event is written in the same transaction with `available_at` backdated an
hour, so the relay (which claims by `available_at`) takes it **before** the
records' own events. Without that, each chunk would queue behind the 500 events
the previous one produced and a 50,000-row import would advance at the speed of
search indexing.

## Consequences

- **Throughput.** Measured on a developer machine: 50,000 rows in ~133 s
  end-to-end through the real relay (~375 rows/s), ~66 s when the import has the
  relay to itself (~760 rows/s, ≈0.6 s per 500-row chunk). The 49,000 side-effect
  events then take the relay a good deal longer to drain, because **the relay
  handles events one at a time, each in two transactions**. That is the
  platform's bottleneck, not the import's, and it is the reason a large import
  does not make records searchable instantly. Batching the relay per tenant and
  handler is the follow-up.
- **Long-held transactions.** An analysis, a staging pass and an export each run
  inside one relay transaction for as long as they take (seconds for analysis and
  staging; minutes for a million-row export). The chunk step is deliberately
  short. If exports grow, they should move to chunked steps like imports.
- **Filter SQL is duplicated** (§9). The alternative — lifting the four modules'
  filter builders into one shared package — touches four merged modules to save
  one file, and is recorded as a follow-up rather than done here. The parity test
  is what makes the copy safe, and it goes red the moment a module's list gains a
  filter or a column that `planQuery` lacks.
- **Deals are not importable.** A row would have to name a pipeline and a stage,
  and MVP_SPEC does not say how a spreadsheet identifies one (by name? by id? what
  when two pipelines share a stage name?). CLAUDE.md §11.8: ask, do not invent.
  Deals are exportable. The descriptors are written so adding them is a rule and a
  descriptor, not a redesign.
- **Account name matching is exact and case-sensitive**, because `lower(name)`
  would defeat `accounts_tenant_name_idx`. Domain is the better key and is
  lower-cased on write.
- **`team` scope can see a teammate's record but not update it**, through the API
  or an import alike: `satisfiesConstraint` resolves team scope via
  `record.teamId`, which no service supplies. The import applies the same record
  check the services do and so inherits the gap rather than papering over it; a
  test records it. Fixing it belongs in the permission engine.
- **The error file echoes the uploader's own cells.** It is the one export whose
  contents an attacker controls directly, so every cell is formula-escaped
  (ADR-0030) and each is truncated at 500 characters.
- **Retention.** Generated files expire (`export_jobs.expires_at`, 24 h; the API
  refuses a link after it) and the bucket carries a 2-day lifecycle rule. A sweep
  that deletes expired objects eagerly is not built.

## Alternatives considered

- **Parse and write inside the request.** Rejected: it is the thing the
  acceptance criterion forbids, and a hostile file could exhaust a process that
  serves everyone.
- **A queue library (BullMQ) for chunks.** CLAUDE.md names BullMQ for "imports,
  emails, automations", but every job here must be atomic with a database write,
  which the outbox gives for free and a second queue would not. Adding Redis as a
  second source of truth for "what is still to do" re-creates the
  crash-between-two-systems problem ADR-0006 exists to avoid.
- **Row-level idempotency keys.** More state, more writes, and the chunk's
  transaction already gives the stronger guarantee.
- **One big transaction for the whole import.** Rejected: 50,000 inserts under one
  lock, nothing visible until the end, and one bad row rolls back everything.
- **Streaming the file through the API to storage.** Rejected by CLAUDE.md §5.12.
